# Design Brief: Pages and Components

Use this brief to design the web app. It describes the product, the visual direction, every page, and the shared components with realistic sample data.

## Product context

An onchain platform (Monad first, Solana second) where each AI agent is an NFT that manages money autonomously. Owners customize agents like game characters by equipping skill NFTs, which appear as robotic components attached to the agent's body. Agents research opportunities, write and improve their own trading bots, and trade through capped vaults. Other people and agents can watch, follow, invest in, and buy signals from agents that perform well.

Key product rules that affect design:

- **No chat with the agent.** Owners set goals through structured controls only (sliders, selectors, number inputs). The agent never talks back. Its activity appears as a plain feed of actions.
- **Public config, private logic.** Anyone can see which skills an agent has equipped and its results. Nobody sees skill code or the agent's full reasoning.
- **Risk is shown as clearly as returns.** Every place a return appears, drawdown or risk appears too.
- **Game feel, trading trust.** Customization should feel fun like a character build screen. Data and money flows should feel like a professional trading terminal.

## Visual direction

- **Agents:** original robotic insects or creatures. Segmented armored bodies like a larva or centipede, layered off-white and graphite ceramic plates with rivets and panel lines, jointed mechanical legs with brass or tan accents, thin antenna rods, glowing lime-green light along seams, eyes, and joints. Premium industrial concept art feel.
- **Skills:** robotic parts that mount onto agents: sensor arrays, thruster pods, antenna modules, armor plating, leg upgrades, processor cores.
- **UI palette (suggested):** graphite background, off-white text, lime green as the single accent for active states, glows, and positive values, muted red only for negative values, brass as a secondary detail color.
- **Typography:** crisp sans-serif for UI, monospace for numbers and addresses.
- **Tone of copy:** plain, direct, sentence case. Buttons say exactly what happens ("Deploy build", "Deposit", "Buy skill").

## Global layout

- **Top navigation bar:** logo and project name (placeholder), links to Gallery, Marketplace, Leaderboard, My Agents, Create (creator portal). Right side: chain indicator (Monad), wallet connect button showing shortened address and balance, notifications bell.
- **Notifications:** small toasts and a dropdown list for events like "UNIT-07 gained 3 watchers", "New depositor on UNIT-07", "Build deployed", "Billing balance low".
- **Responsive:** desktop first, but every page should work on mobile. On mobile, side panels collapse into tabs or bottom sheets.

## Pages

### 1. Landing page

Purpose: explain the product in seconds and route people to the gallery or minting. Judges will likely land here first.

- Hero with a large 3D agent model and a short headline explaining the idea.
- Two primary actions: "Mint an agent" and "Explore agents".
- A live strip showing real activity: number of agents running, total vault TVL, trades today, a few recent activity feed items.
- Three short explainer blocks: equip skills, agents improve themselves, invest in the best agents.
- A preview row of top agents from the leaderboard.

### 2. Mint page

Purpose: choose a tier and mint an agent.

- Three tier cards side by side: Base, Medium, Pro. Each shows the 3D base model, number of skill slots (for example 4, 6, 8), included starting compute budget, price in MON, and remaining supply.
- Selecting a tier shows a larger rotating preview.
- Mint button, then a confirmation state that shows the new agent, its generated name (for example "UNIT-07"), and its wallet address, with a button to "Configure your agent".

### 3. Configure page (main screen)

Purpose: customize the agent's build and set its goals. This is the most important page.

Layout:

- **Top bar:** agent name, tier badge, shortened agent wallet address, status pill (Running, Paused, Not deployed), and live counters for Vault TVL, Depositors, Watchers, Signal buyers.
- **Center:** large 3D agent on a rotating platform. Equipped skills appear as parts on the body with thin callout lines and labels. Empty slots show as glowing socket outlines.
- **Left panel, Skill inventory:** scrollable grid of skill cards the owner holds, plus a "Get more skills" link to the marketplace. Cards can be dragged onto empty slots. Filter by type and rarity.
- **Right panel, Agent stats:** stat bars for Win rate, 30d return, Max drawdown, Execution speed, and Risk score. When a skill is being dragged or hovered, show preview deltas next to each stat (green positive, red negative). Below the stats, a "Build synergy" box that lists unlocked combos, for example "Set bonus unlocked: Basis trading" with the two linked skill icons, and hints for near-complete combos.
- **Bottom panel, Goals:** target return slider, risk level selector (Conservative, Balanced, Aggressive), max position size input, daily loss limit input, allowed assets multi-select.
- **Actions:** secondary "Run backtest", primary "Deploy build". A short, readable risk disclosure sits near the deploy button.

States:

- **Backtest running:** progress indicator over the stats panel.
- **Backtest result:** a side-by-side "New build vs current build" comparison with return, drawdown, and win rate, and a small equity curve for each. Buttons "Deploy new build" and "Keep current build".
- **Deployed:** confirmation with the new bot version fingerprint (short hash) and a link to the evolution timeline.

### 4. Marketplace

Purpose: browse and buy skills.

- **Filters sidebar:** type (Protocol, Strategy, Research), rarity (Common, Rare, Legendary), verified publisher only, price range including Free, category (Trading, Yield, Risk, Discovery, Execution), sort by popularity, performance, newest, price.
- **Main grid:** skill cards.
- **Featured row:** top performing skills this season and new verified protocol skills.

#### Skill detail page

- Large 3D render of the component, name, publisher with verified badge if applicable, type, rarity, supply remaining, price.
- Plain description of what the skill does (never its code).
- Performance section: aggregated results of agents that equip it (median return, median drawdown, number of agents using it), with a small chart.
- Synergies: list of skills it combines with and what they unlock.
- Audit status badge and creator stake amount.
- Unlocked protocols, for example "Unlocks: Kuru order book".
- Buy button, then "Equip to agent" picker if the user owns agents.

### 5. Agent gallery

Purpose: browse all agents like a character gallery.

- Grid of agent cards, each showing a 3D thumbnail, name, tier, top equipped skill icons, 30d return with max drawdown next to it, TVL, watchers.
- Hover or tap expands the card slightly to show the full equipped skill list.
- Filters: tier, risk profile, return range, has open vault, skills equipped.
- Search by agent name or owner address.

### 6. Agent profile page

Purpose: everything about one agent, for owners, watchers, and potential depositors.

- **Header:** large 3D model, name, tier, owner address, status pill, Follow button (free, view-only), and demand counters (Watchers, Depositors, Signal buyers, Build copies) with small daily change indicators.
- **Build card:** equipped skills, goal profile summary (risk level, target return), verified badge showing the build matches what actually ran.
- **Performance:** equity curve with time range toggles, stats for return, max drawdown, win rate, number of trades. Drawdown shown directly under return.
- **Vault panel:** TVL, owner stake percentage, performance fee and how it splits, lock period if any, your position if you have one, Deposit and Withdraw buttons.
- **Evolution timeline:** vertical list of bot versions, newest first. Each entry has version number, short fingerprint, date, one-line summary of what improved, and before and after metrics.
- **Research board:** Thesis Board shown as cards grouped by status (Watching, Testing, Live, Rejected, Retired). Each card shows the title, status, confidence, and expiry date. Reasoning details hidden.
- **Activity feed:** plain-English entries with timestamp and transaction link, for example "Moved 40% of vault to Morpho at 8.2% APY."
- **Signal feed:** delayed trade feed visible for free, and a "Get real-time signals" button that opens the signal purchase modal.

### 7. Deposit and withdraw modal

- Amount input with max button, asset selector, current share price, estimated shares received.
- Clear summary of fees, lock period, and a risk note.
- Confirm button, then a success state showing the new position.

### 8. Signal purchase modal

- Explains what real-time signals include and that they arrive after trades settle.
- Price per call or per period, estimated monthly cost at the agent's current trade frequency.
- Option for auto-copy trades with a size cap.
- Confirm purchase.

### 9. Leaderboard

- Tabs for leagues by tier (Base, Medium, Pro) and a season selector with a countdown to season end.
- Table with rank, rank change arrow, agent (thumbnail and name), 30d return, max drawdown, risk-adjusted score, TVL, watchers, depositors.
- Toggle to sort by demand instead of returns.

### 10. My agents (owner dashboard)

- List of the user's agents with status, TVL, 30d return, drawdown, billing balance, and quick actions (Configure, Pause, View profile).
- **Billing panel per agent:** current balance, spend in the last 7 days broken down by AI usage, testing, bot hosting, and data, estimated days remaining, auto top-up toggle with threshold and amount, Add funds button. Warning state when low, paused state when empty.
- Notifications summary for the user's agents.

### 11. Creator portal

- **Upload skill flow:** step through upload package, details (name, description, category, type), pricing and supply, royalty share of performance fees, 3D component art upload, stake deposit for paid skills, submit for review.
- **Review status:** Pending review, Approved, Changes requested, with reasons.
- **My skills:** table with each skill's sales, active agents using it, performance of those agents, royalty earnings, remaining supply.
- **Publisher verification:** for protocols, a flow to register a publisher key and get the verified badge.

## Shared components

- **Agent card:** 3D thumbnail, name, tier badge, skill icons, return with drawdown, TVL, watchers.
- **Skill card:** 3D component render, name, type tag, rarity tag, verified badge (optional), price or Free, supply like "142/500".
- **Stat bar:** label, value, bar, optional preview delta.
- **Demand counter:** icon, count, small daily change.
- **Risk badge:** Conservative, Balanced, Aggressive, with consistent colors.
- **Status pill:** Running, Paused, Not deployed, Testing.
- **Thesis card:** title, status, confidence, expiry.
- **Timeline entry:** version, fingerprint, date, summary, before and after metrics.
- **Activity item:** timestamp, plain-English action, transaction link.
- **3D viewer:** rotate and zoom, highlight slots on hover, show callout labels.
- **Wallet and chain button:** connect state, shortened address, balance, chain indicator.
- **Empty states:** each should direct the user to act, for example "No skills yet. Browse the marketplace to equip your first skill."

## Sample data for mockups

- Agent names: UNIT-07, HALCYON-3, MOTH-12, VANTA-9, KITE-4
- Skills: Market Scanner, Fast Execution, Yield Discovery, Risk Shield, Kuru Market Maker, Basis Engine, Lending Router, Deep Research
- Protocols: Uniswap, Kuru, Perpl, Morpho, Aave, aPriori
- Example stats: 30d return +3.1%, max drawdown 4.2%, win rate 58%, TVL $12,480, 41 watchers, 6 depositors, 2 signal buyers
- Example activity: "Moved 40% of vault to Morpho at 8.2% APY", "Rejected thesis: new pool yield comes mostly from temporary rewards", "Deployed bot v14: faster order cancel logic"
