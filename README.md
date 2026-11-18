# Blend In — online room server

A small Node.js server that lets players of the Blend In app (Android, or the
game opened outside claude.ai) play together in rooms with a 5-letter code.
It only passes messages between players in the same room; it stores nothing.

- `server.js` — the server (Node 18 or newer, one dependency: `ws`)
- `package.json` — start command and dependency
- `GET /` — health check, returns JSON like
  `{"ok":true,"rooms":1,"players":4,"sent_mb":12.3,"up_hours":5.1}`
- WebSocket on any path (the game uses `/ws`)

## Run it on your own computer (optional test)

```
npm install
npm start          # listens on port 8080 (set PORT to change)
```

## Put it online on Render (free plan)

1. Make a free GitHub account, create a new **public** repository called
   `blendin-server`, and upload all the files from this zip
   with "Add file → Upload files".
2. Make a free Render account at render.com (sign in with GitHub).
3. Render dashboard → **New → Web Service** → pick the `blendin-server` repository.
4. Settings:
   - Language / Runtime: **Node**
   - Build command: `npm install`
   - Start command: `node server.js`
   - Instance type: **Free**
   - Health check path: `/`
5. Press **Deploy**. When it says "Live", the address is shown at the top,
   like `https://blendin-server.onrender.com`. Open it in a browser: you
   should see `{"ok":true,...}`.
6. In the game: **Play online → Server**, type that address, press **Use**.
   (Or send the address to be built into the app, so nobody has to type it.)

Free-plan limits to know:
- After 15 minutes with nobody connected, the server sleeps. The first player
  to connect wakes it; that takes about a minute (the game keeps retrying).
- 750 free hours a month and 5 GB of outgoing traffic a month. The health
  check shows `sent_mb` since the last restart. Past 5 GB, Render either bills
  the overage or pauses the service until next month if no card is added.

For the public Play Store launch, move to a small always-on server
(a paid Render instance or any VPS); nothing in the game has to change
except the address.

## Limits built into the server

- 20 players per room (16 hiders + 4 seekers), 2,000 rooms
- 8 KB per message, 60 messages per second per player
- Room codes: 3–12 lowercase letters/digits
- A player whose connection drops can rejoin as the same player
  (the app keeps a private key for that)
