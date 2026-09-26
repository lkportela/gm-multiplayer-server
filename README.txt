SERVIDOR RAILWAY

Este servidor usa TCP puro na porta interna 6510.
Nao precisa instalar nenhuma dependencia npm.

LOCAL:
  node server.js

RAILWAY:
  1. Suba esta pasta para um repositorio GitHub.
  2. No Railway, conecte o repositorio.
  3. Em Settings > Networking > TCP Proxy, use a porta interna 6510.
  4. O Railway vai fornecer DOMINIO:PORTA externos.
  5. Coloque esses dois valores no Create do obj_network no GameMaker.
