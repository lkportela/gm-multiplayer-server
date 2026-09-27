'use strict';

const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 6510);
const HOST = process.env.HOST || '0.0.0.0';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 12000;
const PARTICIPANT_TIMEOUT_MS = 30000;
const RESUME_GRACE_MS = 15000;

const SERVER_MAX_PLAYERS = Math.max(
    2,
    Math.min(64, Number(process.env.MAX_PLAYERS || 8))
);

const rooms = new Map();
const contexts = new Map();
const resumableRooms = new Map();

function now() {
    return Date.now();
}

function clampInt(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;

    return Math.max(
        min,
        Math.min(max, Math.floor(value))
    );
}

function safeString(value, max, fallback = '') {
    if (typeof value !== 'string') return fallback;

    const clean = value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim();

    return clean.slice(0, max) || fallback;
}

function validId(value) {
    return (
        typeof value === 'string' &&
        /^[A-Za-z0-9_-]{3,64}$/.test(value)
    );
}

function randomId(bytes = 6) {
    return crypto.randomBytes(bytes).toString('hex');
}

function send(socket, packet) {
    if (
        !socket ||
        socket.destroyed ||
        typeof packet !== 'object' ||
        packet === null
    ) {
        return false;
    }

    let line;

    try {
        line = JSON.stringify(packet) + '\n';
    } catch {
        return false;
    }

    if (
        Buffer.byteLength(line, 'utf8') >
        MAX_MESSAGE_BYTES
    ) {
        return false;
    }

    try {
        return socket.write(line, 'utf8');
    } catch {
        return false;
    }
}

function contextFor(socket) {
    let ctx = contexts.get(socket);

    if (!ctx) {
        ctx = {
            socket,
            buffer: '',
            role: 'query',
            roomId: '',
            slot: -1,
            lastSeen: now()
        };

        contexts.set(socket, ctx);
    }

    return ctx;
}

function roomPlayerCount(room) {
    return (
        room &&
        room.hostSocket &&
        !room.hostSocket.destroyed
    )
        ? 1 + room.clients.size
        : 0;
}

function totalPlayers() {
    let total = 0;

    for (const room of rooms.values()) {
        total += roomPlayerCount(room);
    }

    return total;
}

function makeRoomSummary(room) {
    return {
        server_id: room.id,
        name: room.name,
        players: roomPlayerCount(room),
        max_players: room.maxPlayers,
        protocol: room.protocol,
        version: room.version,
        status: room.status
    };
}

function cleanupResumable() {
    const t = now();

    for (const [id, info] of resumableRooms) {
        if (info.expiresAt <= t) {
            resumableRooms.delete(id);
        }
    }
}

function rememberForResume(room) {
    if (!room || !room.id || !room.hostToken) {
        return;
    }

    resumableRooms.set(room.id, {
        id: room.id,
        hostToken: room.hostToken,
        name: room.name,
        maxPlayers: room.maxPlayers,
        protocol: room.protocol,
        version: room.version,
        expiresAt: now() + RESUME_GRACE_MS
    });
}

function closeRoom(
    room,
    reason = 'host_left',
    allowResume = true
) {
    if (
        !room ||
        rooms.get(room.id) !== room
    ) {
        return;
    }

    rooms.delete(room.id);

    if (allowResume) {
        rememberForResume(room);
    }

    for (const [slot, socket] of room.clients) {
        const cctx = contexts.get(socket);

        if (cctx) {
            cctx.role = 'query';
            cctx.roomId = '';
            cctx.slot = -1;
        }

        send(socket, {
            v: room.protocol,
            kind: 'host_left',
            server_id: room.id,
            reason
        });
    }

    room.clients.clear();

    console.log(
        `[room] closed ${room.id} (${reason})`
    );
}

function leaveClient(
    ctx,
    notifyHost = true
) {
    if (!ctx || ctx.role !== 'client') {
        return;
    }

    const room = rooms.get(ctx.roomId);
    const slot = ctx.slot;

    if (
        room &&
        room.clients.get(slot) === ctx.socket
    ) {
        room.clients.delete(slot);

        if (notifyHost) {
            send(room.hostSocket, {
                v: room.protocol,
                kind: 'peer_leave',
                slot
            });
        }

        console.log(
            `[room] ${room.id} client left slot=${slot}`
        );
    }

    ctx.role = 'query';
    ctx.roomId = '';
    ctx.slot = -1;
}

function leaveHost(
    ctx,
    allowResume = true
) {
    if (!ctx || ctx.role !== 'host') {
        return;
    }

    const room = rooms.get(ctx.roomId);

    if (
        room &&
        room.hostSocket === ctx.socket
    ) {
        closeRoom(
            room,
            'host_left',
            allowResume
        );
    }

    ctx.role = 'query';
    ctx.roomId = '';
    ctx.slot = -1;
}

function unregisterContext(ctx) {
    if (!ctx) return;

    if (ctx.role === 'client') {
        leaveClient(ctx, true);
    } else if (ctx.role === 'host') {
        leaveHost(ctx, true);
    }

    contexts.delete(ctx.socket);
}

function allocateSlot(room) {
    for (
        let slot = 1;
        slot < room.maxPlayers;
        slot++
    ) {
        if (!room.clients.has(slot)) {
            return slot;
        }
    }

    return -1;
}

// ---------------------------------------------------------
// STATUS
// ---------------------------------------------------------

function handleStatus(ctx, packet) {
    send(ctx.socket, {
        v: Number.isFinite(packet.v)
            ? packet.v
            : 4,

        kind: 'status',
        online: true,
        players: totalPlayers(),
        max_players: SERVER_MAX_PLAYERS,
        protocol: 4
    });
}

// ---------------------------------------------------------
// PING
// ---------------------------------------------------------

function handlePing(ctx, packet) {
    const nonce = Number.isFinite(packet.nonce)
        ? packet.nonce
        : 0;

    send(ctx.socket, {
        v: Number.isFinite(packet.v)
            ? packet.v
            : 4,

        kind: 'pong',
        nonce
    });
}

// ---------------------------------------------------------
// LISTA DE SERVIDORES
// ---------------------------------------------------------

function handleServerList(ctx, packet) {
    const requestedProtocol =
        Number.isFinite(packet.v)
            ? Math.floor(packet.v)
            : -1;

    const list = [];

    for (const room of rooms.values()) {
        if (room.status !== 'online') {
            continue;
        }

        if (
            !room.hostSocket ||
            room.hostSocket.destroyed
        ) {
            continue;
        }

        if (
            requestedProtocol > 0 &&
            room.protocol !== requestedProtocol
        ) {
            continue;
        }

        list.push(
            makeRoomSummary(room)
        );
    }

    send(ctx.socket, {
        v:
            requestedProtocol > 0
                ? requestedProtocol
                : 4,

        kind: 'server_list',
        servers: list
    });
}

// ---------------------------------------------------------
// HOST
// ---------------------------------------------------------

function handleHostRegister(ctx, packet) {
    if (
        ctx.role !== 'query' &&
        ctx.role !== 'host'
    ) {
        return;
    }

    cleanupResumable();

    const protocol = clampInt(
        packet.protocol ?? packet.v,
        1,
        32,
        4
    );

    const maxPlayers = clampInt(
        packet.max_players,
        2,
        SERVER_MAX_PLAYERS,
        SERVER_MAX_PLAYERS
    );

    const name = safeString(
        packet.name,
        32,
        'Servidor'
    );

    const version = safeString(
        packet.version,
        24,
        '1.0'
    );

    let roomId = '';
    let hostToken = '';

    const resumeId = safeString(
        packet.resume_id,
        64,
        ''
    );

    const suppliedToken = safeString(
        packet.host_token,
        128,
        ''
    );

    if (
        resumeId &&
        suppliedToken
    ) {
        const saved =
            resumableRooms.get(resumeId);

        if (
            saved &&
            saved.hostToken === suppliedToken &&
            saved.expiresAt > now() &&
            !rooms.has(resumeId)
        ) {
            roomId = resumeId;
            hostToken = suppliedToken;

            resumableRooms.delete(
                resumeId
            );
        }
    }

    if (!roomId) {
        do {
            roomId = randomId(6);
        } while (rooms.has(roomId));

        hostToken = randomId(24);
    }

    if (ctx.role === 'host') {
        leaveHost(ctx, false);
    }

    const room = {
        id: roomId,
        name,
        maxPlayers,
        protocol,
        version,

        status: 'starting',

        hostSocket: ctx.socket,
        hostToken,

        clients: new Map(),

        createdAt: now(),
        updatedAt: now()
    };

    rooms.set(roomId, room);

    ctx.role = 'host';
    ctx.roomId = roomId;
    ctx.slot = 0;

    send(ctx.socket, {
        v: protocol,

        kind: 'host_registered',

        server_id: roomId,
        host_token: hostToken,

        resumed:
            resumeId === roomId
    });

    console.log(
        `[room] registered ${roomId} name="${name}" protocol=${protocol}`
    );
}

function handleHostUpdate(ctx, packet) {
    if (ctx.role !== 'host') {
        return;
    }

    const room =
        rooms.get(ctx.roomId);

    if (
        !room ||
        room.hostSocket !== ctx.socket
    ) {
        return;
    }

    if (
        packet.server_id &&
        packet.server_id !== room.id
    ) {
        return;
    }

    room.name = safeString(
        packet.name,
        32,
        room.name
    );

    room.maxPlayers = clampInt(
        packet.max_players,
        2,
        SERVER_MAX_PLAYERS,
        room.maxPlayers
    );

    room.status =
        packet.status === 'online'
            ? 'online'
            : 'starting';

    room.updatedAt = now();

    send(ctx.socket, {
        v: room.protocol,

        kind: 'host_updated',

        server_id: room.id,
        players: roomPlayerCount(room)
    });
}

function handleHostUnregister(ctx, packet) {
    if (ctx.role !== 'host') {
        return;
    }

    const room =
        rooms.get(ctx.roomId);

    if (
        !room ||
        room.hostSocket !== ctx.socket
    ) {
        return;
    }

    if (
        packet.server_id &&
        packet.server_id !== room.id
    ) {
        return;
    }

    closeRoom(
        room,
        'host_closed',
        false
    );

    ctx.role = 'query';
    ctx.roomId = '';
    ctx.slot = -1;
}

// ---------------------------------------------------------
// ENTRAR EM SALA
// ---------------------------------------------------------

function handleJoin(ctx, packet) {
    if (ctx.role === 'client') {
        leaveClient(ctx, true);
    }

    if (ctx.role === 'host') {
        return;
    }

    const serverId = safeString(
        packet.server_id,
        64,
        ''
    );

    if (!validId(serverId)) {
        send(ctx.socket, {
            v: packet.v || 4,

            kind: 'join_error',

            message: 'Servidor invalido.'
        });

        return;
    }

    const room =
        rooms.get(serverId);

    if (!room) {
        cleanupResumable();

        const pending =
            resumableRooms.get(serverId);

        send(ctx.socket, {
            v: packet.v || 4,

            kind: 'join_error',

            retry: !!pending,

            message: pending
                ? 'Servidor reconectando.'
                : 'Servidor nao encontrado.'
        });

        return;
    }

    if (room.status !== 'online') {
        send(ctx.socket, {
            v: room.protocol,

            kind: 'join_error',

            retry: true,

            message: 'Servidor iniciando.'
        });

        return;
    }

    if (
        Number.isFinite(packet.v) &&
        Math.floor(packet.v) !==
            room.protocol
    ) {
        send(ctx.socket, {
            v: packet.v,

            kind: 'join_error',

            message:
                'Versao de protocolo diferente.'
        });

        return;
    }

    const slot =
        allocateSlot(room);

    if (slot < 0) {
        send(ctx.socket, {
            v: room.protocol,

            kind: 'join_error',

            message:
                'Servidor cheio.'
        });

        return;
    }

    ctx.role = 'client';
    ctx.roomId = room.id;
    ctx.slot = slot;

    room.clients.set(
        slot,
        ctx.socket
    );

    room.updatedAt = now();

    send(ctx.socket, {
        v: room.protocol,

        kind: 'join_ok',

        server_id: room.id,
        slot
    });

    send(room.hostSocket, {
        v: room.protocol,

        kind: 'peer_join',

        slot
    });

    console.log(
        `[room] ${room.id} client joined slot=${slot}`
    );
}

// ---------------------------------------------------------
// RELAY
// ---------------------------------------------------------

function handleRelay(ctx, packet) {
    if (
        !packet.data ||
        typeof packet.data !== 'object' ||
        Array.isArray(packet.data)
    ) {
        return;
    }

    let dataSize = 0;

    try {
        dataSize =
            Buffer.byteLength(
                JSON.stringify(packet.data),
                'utf8'
            );
    } catch {
        return;
    }

    if (
        dataSize <= 0 ||
        dataSize > MAX_MESSAGE_BYTES
    ) {
        return;
    }

    // CLIENTE -> HOST
    if (ctx.role === 'client') {
        const room =
            rooms.get(ctx.roomId);

        if (
            !room ||
            room.clients.get(ctx.slot) !==
                ctx.socket ||
            !room.hostSocket ||
            room.hostSocket.destroyed
        ) {
            return;
        }

        send(room.hostSocket, {
            v: room.protocol,

            kind: 'relay',

            from: ctx.slot,

            data: packet.data
        });

        return;
    }

    // HOST -> CLIENTE
    if (ctx.role === 'host') {
        const room =
            rooms.get(ctx.roomId);

        if (
            !room ||
            room.hostSocket !== ctx.socket
        ) {
            return;
        }

        const slot = clampInt(
            packet.to,
            1,
            room.maxPlayers - 1,
            -1
        );

        if (slot < 1) {
            return;
        }

        const target =
            room.clients.get(slot);

        if (
            !target ||
            target.destroyed
        ) {
            return;
        }

        send(target, {
            v: room.protocol,

            kind: 'relay',

            data: packet.data
        });
    }
}

// ---------------------------------------------------------
// PACOTES
// ---------------------------------------------------------

function handlePacket(ctx, packet) {
    if (
        !packet ||
        typeof packet !== 'object' ||
        Array.isArray(packet)
    ) {
        return;
    }

    const kind = safeString(
        packet.kind,
        40,
        ''
    );

    if (!kind) {
        return;
    }

    ctx.lastSeen = now();

    switch (kind) {
        case 'ping':
            return handlePing(
                ctx,
                packet
            );

        case 'status':
            return handleStatus(
                ctx,
                packet
            );

        case 'server_list':
            return handleServerList(
                ctx,
                packet
            );

        case 'host_register':
            return handleHostRegister(
                ctx,
                packet
            );

        case 'host_update':
            return handleHostUpdate(
                ctx,
                packet
            );

        case 'host_unregister':
            return handleHostUnregister(
                ctx,
                packet
            );

        case 'join_server':
            return handleJoin(
                ctx,
                packet
            );

        case 'relay':
            return handleRelay(
                ctx,
                packet
            );

        default:
            return;
    }
}

// ---------------------------------------------------------
// TCP STREAM
// ---------------------------------------------------------

function consume(ctx, chunk) {
    if (
        !Buffer.isBuffer(chunk) ||
        chunk.length === 0
    ) {
        return;
    }

    if (
        Buffer.byteLength(
            ctx.buffer,
            'utf8'
        ) +
            chunk.length >
        MAX_MESSAGE_BYTES * 2
    ) {
        ctx.socket.destroy();
        return;
    }

    ctx.buffer +=
        chunk.toString('utf8');

    for (;;) {
        const idx =
            ctx.buffer.indexOf('\n');

        if (idx < 0) {
            break;
        }

        const line =
            ctx.buffer
                .slice(0, idx)
                .replace(/\r$/, '');

        ctx.buffer =
            ctx.buffer.slice(idx + 1);

        if (!line) {
            continue;
        }

        if (
            Buffer.byteLength(
                line,
                'utf8'
            ) > MAX_MESSAGE_BYTES
        ) {
            ctx.socket.destroy();
            return;
        }

        let packet;

        try {
            packet =
                JSON.parse(line);
        } catch {
            continue;
        }

        handlePacket(
            ctx,
            packet
        );
    }
}

// ---------------------------------------------------------
// SERVIDOR TCP
// ---------------------------------------------------------

const server =
    net.createServer(
        (socket) => {

            socket.setNoDelay(true);

            socket.setKeepAlive(
                true,
                10000
            );

            const ctx =
                contextFor(socket);

            console.log(
                `[tcp] connect ${
                    socket.remoteAddress || '?'
                }:${
                    socket.remotePort || '?'
                }`
            );

            socket.on(
                'data',
                (chunk) =>
                    consume(
                        ctx,
                        chunk
                    )
            );

            socket.on(
                'error',
                (err) =>
                    console.log(
                        `[tcp] error ${
                            err.code ||
                            err.message
                        }`
                    )
            );

            socket.on(
                'close',
                () => {

                    unregisterContext(
                        ctx
                    );

                    console.log(
                        '[tcp] disconnect'
                    );
                }
            );
        }
    );

// ---------------------------------------------------------
// TIMEOUT / LIMPEZA
// ---------------------------------------------------------

setInterval(
    () => {

        const t = now();

        cleanupResumable();

        for (
            const ctx of contexts.values()
        ) {

            const limit =
                ctx.role === 'query'
                    ? QUERY_TIMEOUT_MS
                    : PARTICIPANT_TIMEOUT_MS;

            if (
                t - ctx.lastSeen >
                    limit &&
                !ctx.socket.destroyed
            ) {
                ctx.socket.destroy();
            }
        }

    },
    5000
).unref();

// ---------------------------------------------------------
// ERROS
// ---------------------------------------------------------

server.on(
    'error',
    (err) => {

        console.error(
            '[server] fatal',
            err
        );

        process.exitCode = 1;
    }
);

// ---------------------------------------------------------
// START
// ---------------------------------------------------------

server.listen(
    PORT,
    HOST,
    () => {

        console.log(
            `[server] TCP RAW listening on ${HOST}:${PORT}`
        );

        console.log(
            `[server] protocol 4`
        );

        console.log(
            `[server] max players ${SERVER_MAX_PLAYERS}`
        );
    }
);
