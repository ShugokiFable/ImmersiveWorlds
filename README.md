# Immersive Worlds: Living Cities

A SillyTavern extension that turns every roleplay chat into a **persistent, living world**. Instead of a static lore dump, a background "director" quietly maintains a real simulation — a city with a clock, weather, streets you can travel, people with goals, items with owners, factions, rumors, and events — and weaves its atmosphere into every single reply.

> **v1.4.0** — Character making is first-class: any world NPC becomes a deep SillyTavern character card with a bundled world lorebook, an AI forge casts new characters on demand, and quest threads are now visible in the panel.

---

## Features

### 🏙️ A world that exists between messages
- **AI bootstrap** — one click generates a whole city: locations, NPCs, items, factions, events, and a premise, all coherent with your character.
- **Living director** — after every turn the director advances the clock, shifts the weather, evolves events and rumors, moves NPCs, and records continuity notes into a chronicle.
- **Active materialization** — mention a shopfront, a key, a passerby, a dead-drop… and the director creates it *now*: new items, new POIs, new characters, new events — gated by your settings and a per-pass growth budget.
- **Travelable map** — locations are linked; click a connection to travel, and the scene follows you.

### 🌫️ Atmosphere you can feel
- The director writes a **sensory ambient line** (light, weather, smell, sound, texture, mood) every pass.
- Every reply is grounded in a prose **SCENE BRIEF** — time, weather, who's present, what's stirring — instead of a robotic JSON dump of the world state.
- Optional ambient theming tints the whole SillyTavern UI by time of day (dawn / day / dusk / night).

### 🎭 Characters you can take anywhere

- **Deep materialization** — turn any world NPC into a full character card: description woven from goals, secrets, faction ties, owned items and their home location — reviewed and editable before anything is created.
- **Bundled world lorebook** — every created card carries a lorebook of its world (always-on premise entry, keyed home district, nearby places, signature items), so it remembers where it came from.
- **Character forge** — describe a concept (or leave it blank to be surprised) and the director casts brand-new, world-consistent NPCs into the current scene.
- **Quests panel** — active and finished storylines are visible in the World tab instead of only whispering through the scene brief.

### ⚙️ Built for reasoning models
- State updates run with **reasoning disabled** on OpenRouter (`effort: none`) so DeepSeek-style thinking models emit JSON instead of burning the token budget on chain-of-thought.
- Real token budgets (bootstrap 6000 / director 3000, configurable) with automatic headroom on retry.
- Honest error messages — the toast shows the *actual* failure, not "check your API connection".
- **Never blocks your replies** — the director runs detached from generation with a 120s hard timeout, so a slow or hung API call can't stall the character.
- **Token-lean by design** — slim world-state views, capped character lore, and a compact scene brief keep every background pass and every reply cheap.

---

## Installation

Requirements: **SillyTavern ≥ 1.18.0** and any chat-completions API (OpenAI, OpenRouter + DeepSeek/Claude/GPT, etc.).

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/ShugokiFable/ImmersiveWorlds.git
```

Then **restart SillyTavern** (or hard-refresh the browser with Ctrl+F5) and enable **Immersive Worlds: Living Cities** in the extensions menu.

> Updates: `git -C public/scripts/extensions/third-party/ImmersiveWorlds pull`

---

## Usage

1. **Generate your world** — open the panel (floating button bottom-right) and hit **Generate world**, or just start chatting; the world bootstraps on the first message.
2. **Travel** — the World tab shows your current location and its connections; click a connection to move.
3. **Watch it live** — with the director enabled, every turn advances the simulation. New items, POIs, NPCs, and events appear as the story implies them.
4. **Inspect** — People / Items / Timeline tabs; add or edit entries manually; export / import world JSON.
5. **Run the director manually** — hit **Advance world** in the panel anytime.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `autoDirector` | on | Run the director automatically after every user message |
| `directorEvery` | 1 | Run the director every N messages |
| `simulationDetail` | high | Growth budget per pass: low (1 item), high (2 items + 1 POI + 1 NPC + 1 event), maximum (3 + 2 + 2 + 1) |
| `allowNewCharacters` | on | Allow lore-consistent dynamic NPC creation |
| `allowNewItems` | on | Allow dynamic item creation |
| `allowNewLocations` | on | Allow dynamic locations / points of interest |
| `allowOffscreenEvents` | on | Simulate restrained off-screen events |
| `strictUserAgency` | on | Protect user actions, thoughts, and dialogue |
| `bootstrapTokens` | 6000 | Token budget for world generation |
| `directorTokens` | 3000 | Token budget for each director pass |
| `jsonTemperature` | 0.5 | Temperature used for state-update calls (lower = more reliable JSON) |
| `disableReasoning` | on | Disable thinking on OpenRouter during state updates (recommended for reasoning models) |
| `nativeStructuredOutput` | off | Try native `json_schema` structured output first (only for models that support it) |
| `suspendDirectorOnApiError` | on | Auto-suspend the director if the API rejects a background request |
| `injectDepth` | 2 | Chat depth for the scene brief injection |
| `immersiveTheme` / `ambientEffects` / `showFloatingButton` | on | UI layer: modern theme, time-of-day ambient tint, floating panel button |

## Changelog

- **1.4.0** — Character making & story visibility: deep character cards (goals/secrets/factions/inventory/home woven into the description) with edit-before-create; created cards bundle a world lorebook (WI import + `world` binding); new **Forge** button casts 1–2 fresh world-consistent NPCs from a concept; the director now advances quest threads and NPC routines between passes; Quests section in the World tab; LLM markup sanitized out of card descriptions.
- **1.3.0** — Token efficiency & reply reliability: director input cut ~86% (slim world state, capped character lore, 6-message transcript); scene brief on every reply ~80% smaller; director no longer blocks the character reply (detached + 120s hard timeout); crash guards for undefined chat entries (fixes `TypeError: Cannot read properties of undefined` in the ST log).
- **1.2.0** — Active world materialization; `allowNewLocations`; two-way auto-linking of new POIs; Atmosphere card + weather icons in the panel; dialog width fix; growth budgets per `simulationDetail`.
- **1.1.0** — Reasoning-safe generation for OpenRouter/DeepSeek (thinking disabled, real token budgets, honest errors); prose SCENE BRIEF injection; director ambient lines persisted.
- **1.0.1** — Initial published build.

---

*Built for adults. Any resemblance to real persons or places is coincidental.*
