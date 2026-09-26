const net = require("net");

// Porta interna. No Railway crie um TCP Proxy apontando para 6510.
const PORT = 6510;
const HOST = "0.0.0.0";

let nextId = 1;
const clients = new Map();

function safeSend(socket, packet) {
  if (!socket.destroyed) socket.write(JSON.stringify(packet) + "\n");
}

function snapshot() {
  const players = [];
  for (const client of clients.values()) {
    players.push({ id: client.id, x: client.x, y: client.y });
  }
  const packet = { t: "snapshot", players };
  for (const client of clients.values()) safeSend(client.socket, packet);
}

function spawnFor(id) {
  return {
    x: 100 + ((id * 137) % 760),
    y: 100 + ((id * 83) % 340),
  };
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);

  const id = nextId++;
  const spawn = spawnFor(id);
  const client = {
    socket,
    id,
    x: spawn.x,
    y: spawn.y,
    incoming: "",
  };
  clients.set(socket, client);

  console.log(`[+] Player ${id} conectado - ${socket.remoteAddress}`);
  safeSend(socket, { t: "welcome", id, x: client.x, y: client.y });
  snapshot();

  socket.on("data", (data) => {
    client.incoming += data.toString("utf8");

    let newline;
    while ((newline = client.incoming.indexOf("\n")) >= 0) {
      const line = client.incoming.slice(0, newline).trim();
      client.incoming = client.incoming.slice(newline + 1);
      if (!line) continue;

      try {
        const packet = JSON.parse(line);

        if (packet.t === "hello") {
          safeSend(socket, { t: "welcome", id, x: client.x, y: client.y });
          continue;
        }

        if (packet.t === "pos") {
          const x = Number(packet.x);
          const y = Number(packet.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

          // Limites da room de teste.
          client.x = Math.max(16, Math.min(944, x));
          client.y = Math.max(16, Math.min(524, y));
          snapshot();
        }
      } catch (err) {
        console.log(`[!] Pacote invalido do Player ${id}`);
      }
    }
  });

  socket.on("close", () => {
    if (clients.delete(socket)) {
      console.log(`[-] Player ${id} desconectou`);
      snapshot();
    }
  });

  socket.on("error", (err) => {
    console.log(`[!] Player ${id}: ${err.message}`);
  });
});

server.on("error", (err) => {
  console.error("Erro do servidor:", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor multiplayer rodando em ${HOST}:${PORT}`);
  console.log("Aguardando jogadores...");
});
