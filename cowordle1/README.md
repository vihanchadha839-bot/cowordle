# CoWordle

Two player Wordle you play with a friend online.

## Modes

**Co-op**: one shared board, you take turns guessing. You can see your friend typing live and build on their colours. Solve it together in 6.

**Versus**: you both get the same secret word and race. You can see your opponent's board filling up with green, yellow and grey (and boxes filling as they type) but never their letters. First to solve wins. Letters get revealed at the end.

## Word bank

About 2,300 possible answer words and around 13,000 accepted guesses. Words don't repeat in the same room until the pool runs out.

## Run locally

```
npm install
npm start
```

Open http://localhost:3000 in two tabs.

## Deploy on Render

1. Push these files to a GitHub repo (everything sits in one folder, no subfolders)
2. On Render: New > Web Service > pick the repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Leave Root Directory empty
