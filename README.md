# Polícia, Vítima e Assassino — MVP

Jogo multiplayer de dedução e perseguição. 3 jogadores, 15 minutos.

## Estrutura
- `docs/` — cliente PWA (servido pelo GitHub Pages)
- `server/` — servidor WebSocket (hospedado no Render)

## Deploy
### 1) Servidor (Render)
- New Web Service → conecte este repositório
- Root Directory: `server`
- Build: `npm install` • Start: `node server.js`
- Anote a URL gerada: `https://SEU-SERVIDOR.onrender.com`

### 2) Cliente (GitHub Pages)
- Settings → Pages → Source: *Deploy from a branch*
- Branch: `main` • Folder: `/docs` → Save

### 3) Conectar cliente ao servidor
Em `docs/app.js`, troque:
```js
SERVER_HOST: 'pva-server.onrender.com'