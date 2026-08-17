import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    generateRaw,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';

const MODULE_ID = 'immersive_worlds';
const PROMPT_ID = 'IMMERSIVE_WORLDS_STATE';
const STATE_KEY = 'immersive_worlds_state_v1';
const PANEL_ID = 'iw-world-panel';
const SETTINGS_ID = 'iw-settings-block';
const MAX_CHRONICLE = 40;

const defaultSettings = Object.freeze({
    enabled: true,
    autoDirector: true,
    directorEvery: 1,
    bootstrapTokens: 6000,
    directorTokens: 3000,
    jsonTemperature: 0.5,
    disableReasoning: true,
    injectDepth: 2,
    immersiveTheme: true,
    ambientEffects: true,
    showFloatingButton: true,
    maxNpcs: 48,
    maxItems: 80,
    maxLocations: 36,
    simulationDetail: 'high',
    allowNewCharacters: true,
    allowNewItems: true,
    allowNewLocations: true,
    allowOffscreenEvents: true,
    strictUserAgency: true,
    nativeStructuredOutput: false,
    suspendDirectorOnApiError: true,
});

let activeTab = 'world';
let directorBusy = false;
let initialized = false;
let saveTimer = null;
let consecutiveDirectorFailures = 0;

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function settings() {
    if (!extension_settings[MODULE_ID]) {
        extension_settings[MODULE_ID] = structuredClone(defaultSettings);
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_ID][key] === undefined) {
            extension_settings[MODULE_ID][key] = value;
        }
    }
    return extension_settings[MODULE_ID];
}

function nowIso() {
    return new Date().toISOString();
}

function slug(value, prefix = 'id') {
    const cleaned = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 42);
    return cleaned || `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function uniqueId(collection, preferred, prefix) {
    const used = new Set(collection.map(x => x.id));
    let base = slug(preferred, prefix);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    return id;
}

function cleanText(value, max = 800) {
    const div = document.createElement('div');
    div.innerHTML = String(value ?? '');
    return (div.textContent || div.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function currentCharacterSummary() {
    const ctx = getContext();
    if (!ctx) return '';
    if (ctx.groupId) {
        const group = ctx.groups?.find(g => String(g.id) === String(ctx.groupId));
        const members = (group?.members || [])
            .map(avatar => ctx.characters?.find(c => c.avatar === avatar))
            .filter(Boolean)
            .map(c => `${c.name}: ${cleanText(c.description || c.personality, 500)}`);
        return `Active ensemble: ${members.join('\n')}`.slice(0, 5000);
    }
    const c = ctx.characters?.[ctx.characterId];
    if (!c) return '';
    const bookEntries = c?.data?.character_book?.entries || [];
    const lore = bookEntries.slice(0, 20).map(e => cleanText(e.content, 450)).filter(Boolean).join('\n');
    return [
        `Character: ${c.name || ''}`,
        `Description: ${cleanText(c.description, 1800)}`,
        `Personality: ${cleanText(c.personality, 1000)}`,
        `Scenario: ${cleanText(c.scenario, 1400)}`,
        lore ? `Embedded lore:\n${lore}` : '',
    ].filter(Boolean).join('\n');
}

function baseWorld() {
    const ctx = getContext();
    const c = ctx?.characters?.[ctx.characterId];
    const worldName = c?.name ? `${c.name}'s World` : 'Living World';
    const locationName = cleanText(c?.scenario, 80) || 'The Current Scene';
    const locationId = slug(locationName, 'location');
    const npcs = [];
    if (c?.name) {
        npcs.push({
            id: uniqueId(npcs, c.name, 'npc'),
            name: c.name,
            role: 'Primary character',
            appearance: cleanText(c.description, 500),
            personality: cleanText(c.personality, 500),
            goals: [],
            relationship: 'Established by the current chat',
            locationId,
            status: 'present',
            secrets: [],
            inventory: [],
            firstSeen: nowIso(),
            lastSeen: nowIso(),
            materializedAvatar: c.avatar || '',
        });
    }
    return normalizeState({
        version: 1,
        worldName,
        premise: cleanText(c?.scenario || c?.description, 1200),
        genre: 'adaptive roleplay',
        tone: 'immersive and grounded',
        rules: [],
        clock: { day: 1, time: '09:00', weather: 'clear', season: 'unspecified' },
        currentLocationId: locationId,
        locations: [{
            id: locationId,
            name: locationName,
            type: 'scene',
            description: cleanText(c?.scenario, 800) || 'The place where the current scene begins.',
            connections: [],
            discovered: true,
            danger: 'unknown',
        }],
        npcs,
        items: [],
        factions: [],
        events: [],
        quests: [],
        player: { currency: 0, reputation: {}, inventoryIds: [] },
        chronicle: [{ at: nowIso(), text: 'Living-world simulation initialized.' }],
        meta: { createdAt: nowIso(), updatedAt: nowIso(), tick: 0, lastProcessedSignature: '' },
    });
}

function normalizeArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeState(input) {
    const state = input && typeof input === 'object' ? input : {};
    state.version = 1;
    state.worldName = String(state.worldName || 'Living World').slice(0, 120);
    state.premise = String(state.premise || '').slice(0, 4000);
    state.genre = String(state.genre || 'adaptive roleplay').slice(0, 100);
    state.tone = String(state.tone || 'immersive').slice(0, 200);
    state.rules = normalizeArray(state.rules).map(String).slice(0, 20);
    state.clock = { day: 1, time: '09:00', weather: 'clear', season: 'unspecified', ...(state.clock || {}) };
    state.locations = normalizeArray(state.locations).map((x, i) => ({
        id: slug(x.id || x.name || `location-${i + 1}`, 'location'),
        name: String(x.name || `Location ${i + 1}`).slice(0, 120),
        type: String(x.type || 'place').slice(0, 80),
        description: String(x.description || '').slice(0, 1600),
        connections: normalizeArray(x.connections).map(v => slug(v, 'location')).slice(0, 20),
        discovered: x.discovered !== false,
        danger: String(x.danger || 'unknown').slice(0, 80),
    }));
    if (!state.locations.length) state.locations.push(baseWorld().locations[0]);
    state.currentLocationId = slug(state.currentLocationId || state.locations[0].id, 'location');
    if (!state.locations.some(x => x.id === state.currentLocationId)) state.currentLocationId = state.locations[0].id;
    state.npcs = normalizeArray(state.npcs).map((x, i) => ({
        id: slug(x.id || x.name || `npc-${i + 1}`, 'npc'),
        name: String(x.name || `Unknown ${i + 1}`).slice(0, 100),
        role: String(x.role || 'resident').slice(0, 160),
        appearance: String(x.appearance || '').slice(0, 900),
        personality: String(x.personality || '').slice(0, 900),
        goals: normalizeArray(x.goals).map(String).slice(0, 8),
        relationship: String(x.relationship || 'unknown').slice(0, 500),
        locationId: slug(x.locationId || state.currentLocationId, 'location'),
        status: String(x.status || 'active').slice(0, 100),
        secrets: normalizeArray(x.secrets).map(String).slice(0, 6),
        inventory: normalizeArray(x.inventory).map(String).slice(0, 20),
        firstSeen: x.firstSeen || nowIso(),
        lastSeen: x.lastSeen || nowIso(),
        materializedAvatar: String(x.materializedAvatar || ''),
    }));
    state.items = normalizeArray(state.items).map((x, i) => ({
        id: slug(x.id || x.name || `item-${i + 1}`, 'item'),
        name: String(x.name || `Item ${i + 1}`).slice(0, 120),
        type: String(x.type || 'object').slice(0, 100),
        description: String(x.description || '').slice(0, 1000),
        rarity: String(x.rarity || 'ordinary').slice(0, 80),
        quantity: Math.max(1, Number(x.quantity) || 1),
        ownerId: x.ownerId ? slug(x.ownerId, 'npc') : '',
        locationId: x.locationId ? slug(x.locationId, 'location') : state.currentLocationId,
        properties: normalizeArray(x.properties).map(String).slice(0, 12),
    }));
    state.factions = normalizeArray(state.factions).slice(0, 24);
    state.events = normalizeArray(state.events).slice(0, 40);
    state.quests = normalizeArray(state.quests).slice(0, 30);
    state.player = { currency: 0, reputation: {}, inventoryIds: [], ...(state.player || {}) };
    state.player.inventoryIds = normalizeArray(state.player.inventoryIds).map(v => slug(v, 'item'));
    state.chronicle = normalizeArray(state.chronicle).map(x => typeof x === 'string' ? { at: nowIso(), text: x } : x).slice(-MAX_CHRONICLE);
    state.meta = { createdAt: nowIso(), updatedAt: nowIso(), tick: 0, lastProcessedSignature: '', ...(state.meta || {}) };
    state.scene = { ambient: '', ...(state.scene && typeof state.scene === 'object' ? state.scene : {}) };
    state.scene.ambient = String(state.scene.ambient || '').slice(0, 500);
    return state;
}

function getState(create = true) {
    const ctx = getContext();
    if (!ctx?.chatMetadata) return create ? baseWorld() : null;
    if (!ctx.chatMetadata[STATE_KEY] && create) ctx.chatMetadata[STATE_KEY] = baseWorld();
    if (ctx.chatMetadata[STATE_KEY]) ctx.chatMetadata[STATE_KEY] = normalizeState(ctx.chatMetadata[STATE_KEY]);
    return ctx.chatMetadata[STATE_KEY] || null;
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const ctx = getContext();
        const state = getState(false);
        if (!ctx || !state) return;
        state.meta.updatedAt = nowIso();
        try {
            await ctx.saveMetadata();
        } catch (error) {
            console.error('[Immersive Worlds] Failed to save world state', error);
        }
    }, 300);
}

function currentLocation(state) {
    return state.locations.find(x => x.id === state.currentLocationId) || state.locations[0];
}

function conciseState(state) {
    const loc = currentLocation(state);
    const present = state.npcs.filter(n => n.locationId === state.currentLocationId && n.status !== 'dead').slice(0, 12);
    const localItems = state.items.filter(i => i.locationId === state.currentLocationId || present.some(n => n.id === i.ownerId)).slice(0, 16);
    const activeEvents = state.events.filter(e => !e.resolved).slice(-8);
    const activeQuests = state.quests.filter(q => !['resolved', 'failed', 'complete'].includes(String(q.status).toLowerCase())).slice(-8);
    return {
        world: state.worldName,
        premise: state.premise,
        genre: state.genre,
        tone: state.tone,
        rules: state.rules,
        clock: state.clock,
        location: loc,
        nearbyLocations: state.locations.filter(x => loc?.connections?.includes(x.id)).slice(0, 10),
        presentCharacters: present,
        localItems,
        activeEvents,
        activeQuests,
        player: state.player,
        recentChronicle: state.chronicle.slice(-8),
    };
}

const WEATHER_ATMOSPHERE = {
    clear: 'The sky is clear and the light is sharp.',
    sunny: 'The sky is clear and the light is sharp.',
    cloudy: 'Cloud cover softens the light and washes out colors.',
    overcast: 'Low cloud presses down, muffling sound and color.',
    rain: 'Rain patters steadily and the air smells of wet stone.',
    raining: 'Rain patters steadily and the air smells of wet stone.',
    storm: 'Wind-driven rain and distant thunder make the world feel small.',
    thunderstorm: 'Wind-driven rain and distant thunder make the world feel small.',
    snow: 'Snow falls in silence, hushing every sound under a white blanket.',
    fog: 'Fog swallows the distance and turns familiar shapes into guesses.',
    mist: 'Thin mist drifts through the streets, blurring edges and voices.',
    haze: 'Heat haze shimmers over the ground and the air tastes of dust.',
    wind: 'A restless wind pushes loose things about and snaps at clothing.',
    humid: 'The air is heavy and damp, and everything sticks to the skin.',
    hot: 'The heat presses down, and even the shade feels tired.',
    cold: 'The cold bites; breath fogs and metal stings to the touch.',
};

const TIME_ATMOSPHERE = {
    night: 'Lamplight pools in the dark, and the world narrows to pools of warmth.',
    dawn: 'The first grey light creeps over the horizon, washing the world in blue.',
    day: 'The day is at full stretch, light and shadow in constant motion.',
    dusk: 'Long shadows stretch and the light turns amber before it fails.',
};

const WEATHER_ICONS = {
    clear: 'fa-sun', sunny: 'fa-sun', cloudy: 'fa-cloud', overcast: 'fa-cloud',
    rain: 'fa-cloud-rain', raining: 'fa-cloud-rain', storm: 'fa-cloud-bolt',
    thunderstorm: 'fa-cloud-bolt', snow: 'fa-snowflake', fog: 'fa-smog',
    mist: 'fa-smog', haze: 'fa-smog', wind: 'fa-wind', humid: 'fa-droplet',
    hot: 'fa-temperature-high', cold: 'fa-temperature-low',
};

function timeSlotOf(state) {
    const hour = Number(String(state.clock?.time || '12:00').split(':')[0]) || 12;
    return hour < 6 ? 'night' : hour < 10 ? 'dawn' : hour < 18 ? 'day' : hour < 21 ? 'dusk' : 'night';
}

function atmosphereLine(state) {
    const weatherKey = String(state.clock?.weather || 'clear').toLowerCase().replace(/[^a-z]+/g, '');
    const ambient = String(state.scene?.ambient || '').trim();
    if (ambient) return ambient;
    const atmos = [WEATHER_ATMOSPHERE[weatherKey] || '', TIME_ATMOSPHERE[timeSlotOf(state)] || ''].filter(Boolean).join(' ');
    return atmos || cleanText(currentLocation(state)?.description || 'The scene waits, still and watchful.', 500);
}

function buildSceneBrief(state) {
    const loc = currentLocation(state);
    const lines = [];
    lines.push(`Day ${state.clock?.day || 1}, ${state.clock?.time || '09:00'} — ${String(state.clock?.weather || 'clear')}. ${loc?.name || 'The current scene'} (${loc?.type || 'place'}).`);
    lines.push(atmosphereLine(state));
    const present = state.npcs.filter(n => n.locationId === state.currentLocationId && n.status !== 'dead').slice(0, 10);
    if (present.length) {
        lines.push('Present: ' + present.map(n => `${n.name} (${n.role})${n.personality ? ` — ${cleanText(n.personality, 140)}` : ''}`).join('; '));
    }
    const connected = (loc?.connections || []).map(id => state.locations.find(x => x.id === id)?.name).filter(Boolean);
    if (connected.length) {
        lines.push('Nearby: ' + connected.slice(0, 6).join(', ') + '.');
    }
    const events = state.events.filter(e => !e.resolved && String(e.status || '').toLowerCase() !== 'resolved').slice(-3);
    if (events.length) {
        lines.push('Stirring: ' + events.map(e => cleanText(e.name || e.title || e.summary || e.description, 120)).join('; '));
    }
    const items = state.items.filter(i => i.locationId === state.currentLocationId && !i.ownerId).slice(0, 5);
    if (items.length) {
        lines.push('On hand: ' + items.map(i => i.name).join(', ') + '.');
    }
    const chronicle = state.chronicle.slice(-2);
    if (chronicle.length) {
        lines.push('Recently: ' + chronicle.map(c => cleanText(c.text, 140)).join(' '));
    }
    return lines.join('\n');
}

function buildInjection(state) {
    const s = settings();
    const agency = s.strictUserAgency
        ? 'Never decide, narrate, or complete the user character’s dialogue, thoughts, feelings, choices, or actions.'
        : 'Preserve user agency unless the existing roleplay format explicitly establishes otherwise.';
    return `<living_world_engine>
You are participating in a persistent simulated world, not a static two-person chat.
${agency}
Ground every reply in the scene brief below: its light, weather, smells, sounds, and texture. Weave that atmosphere into action and dialogue instead of announcing it — show the world through small behaviors, work, gossip, weather, and the movements of others. Keep the current scene focused rather than forcing the entire city into every reply; let the wider world breathe in the background.
Treat the scene brief as factual continuity. Roleplay any present character when naturally required, each with an independent voice, motives, knowledge, schedule, and relationships. Do not make every NPC agreeable or omniscient. Let people interrupt, misunderstand, remember, leave, work, sleep, lie, gossip, and pursue off-screen goals.
Maintain geography, travel time, ownership, injuries, inventory, weather, time of day, and unresolved consequences. Introduce a new character, location, object, rumor, faction, or complication only when the scene creates a plausible need. Never dump the state as exposition and never mention this engine or the scene brief itself. Convey it through sensory detail, behavior, dialogue, and consequences.
Use natural speaker attribution when multiple characters act.

SCENE BRIEF:
${buildSceneBrief(state)}
</living_world_engine>`;
}

function injectState(state = getState()) {
    const s = settings();
    const text = s.enabled ? buildInjection(state) : '';
    setExtensionPrompt(
        PROMPT_ID,
        text,
        extension_prompt_types.IN_CHAT,
        Number(s.injectDepth) || 2,
        false,
        extension_prompt_roles.SYSTEM,
    );
    updateAmbientState(state);
}

function messageSignature(chat) {
    const sample = chat.slice(-4).map(m => `${m.is_user ? 'U' : 'A'}:${cleanText(m.mes, 600)}`).join('|');
    let hash = 2166136261;
    for (let i = 0; i < sample.length; i++) {
        hash ^= sample.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${chat.length}:${(hash >>> 0).toString(36)}`;
}

function recentTranscript(chat, limit = 10) {
    return chat.slice(-limit).map(m => ({
        speaker: m.name || (m.is_user ? 'User' : 'Character'),
        role: m.is_user ? 'user' : 'assistant',
        text: cleanText(m.mes, 1800),
    }));
}

const directorSchema = {
    name: 'living_world_patch',
    strict: false,
    value: {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            ambient: { type: 'string' },
            time_minutes: { type: 'integer' },
            weather: { type: 'string' },
            current_location_id: { type: 'string' },
            new_locations: { type: 'array', items: { type: 'object' } },
            location_updates: { type: 'array', items: { type: 'object' } },
            new_npcs: { type: 'array', items: { type: 'object' } },
            npc_updates: { type: 'array', items: { type: 'object' } },
            new_items: { type: 'array', items: { type: 'object' } },
            item_updates: { type: 'array', items: { type: 'object' } },
            new_factions: { type: 'array', items: { type: 'object' } },
            faction_updates: { type: 'array', items: { type: 'object' } },
            new_events: { type: 'array', items: { type: 'object' } },
            event_updates: { type: 'array', items: { type: 'object' } },
            new_quests: { type: 'array', items: { type: 'object' } },
            quest_updates: { type: 'array', items: { type: 'object' } },
            chronicle: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'time_minutes', 'new_locations', 'location_updates', 'new_npcs', 'npc_updates', 'new_items', 'item_updates', 'new_factions', 'faction_updates', 'new_events', 'event_updates', 'new_quests', 'quest_updates', 'chronicle'],
    },
};

const bootstrapSchema = {
    name: 'living_world',
    strict: false,
    value: {
        type: 'object',
        properties: {
            worldName: { type: 'string' },
            premise: { type: 'string' },
            genre: { type: 'string' },
            tone: { type: 'string' },
            rules: { type: 'array', items: { type: 'string' } },
            clock: { type: 'object' },
            currentLocationId: { type: 'string' },
            locations: { type: 'array', items: { type: 'object' } },
            npcs: { type: 'array', items: { type: 'object' } },
            items: { type: 'array', items: { type: 'object' } },
            factions: { type: 'array', items: { type: 'object' } },
            events: { type: 'array', items: { type: 'object' } },
            quests: { type: 'array', items: { type: 'object' } },
            player: { type: 'object' },
        },
        required: ['worldName', 'premise', 'genre', 'tone', 'clock', 'currentLocationId', 'locations', 'npcs', 'items'],
    },
};

function parseJson(value) {
    if (typeof value === 'object' && value) return value;
    let text = String(value ?? '').replace(/^\uFEFF/, '').trim();
    if (!text) {
        throw new Error('The model returned an empty response. If it is a reasoning model, raise the world/director token budgets or disable reasoning for world calls.');
    }
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(text); } catch { /* continue */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const candidate = text.slice(start, end + 1);
        try { return JSON.parse(candidate); } catch (error) {
            const truncated = /[}\]]\s*$/.test(candidate) && text.slice(end + 1).trim().length > 0 ? ' (output continues after the closing brace — likely truncated)' : '';
            throw new Error(`The director returned invalid JSON${truncated || (text.length >= 3800 ? ' — the output looks truncated' : '')}. ${String(error.message).slice(0, 140)}`);
        }
    }
    throw new Error('The director did not return valid JSON.');
}

function clampBudget(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function schemaContract(schema) {
    return JSON.stringify(schema?.value || schema || {}, null, 2);
}

function errorText(error) {
    if (!error) return 'Unknown API error';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || error.name;
    try { return JSON.stringify(error); } catch { return String(error); }
}

function isRequestRejection(error) {
    return /(?:status\s*)?400|bad request|unsupported|response[_ -]?format|json[_ -]?schema|tool[_ -]?choice/i.test(errorText(error));
}

async function withJsonBias(action) {
    // Temporarily steer the active Chat Completion settings toward reliable JSON:
    // low temperature, and — when the user opts in — reasoning disabled. Reasoning
    // models (DeepSeek R1/V3/V4, etc.) can burn the entire token budget on
    // chain-of-thought and return content:null, which surfaces as "No message
    // generated" in generateRaw. SillyTavern maps reasoning_effort 'min' + hidden
    // thoughts to OpenRouter effort 'none', which switches thinking off cleanly.
    const oai = oai_settings;
    if (!oai) return action();
    const saved = { temp: oai.temp_openai, effort: oai.reasoning_effort, thoughts: oai.show_thoughts };
    try {
        const t = Number(settings().jsonTemperature);
        oai.temp_openai = (Number.isFinite(t) && t >= 0 && t <= 2) ? t : 0.5;
        if (settings().disableReasoning && String(oai.chat_completion_source) === 'openrouter') {
            oai.reasoning_effort = 'min';
            oai.show_thoughts = false;
        }
        return await action();
    } finally {
        oai.temp_openai = saved.temp;
        oai.reasoning_effort = saved.effort;
        oai.show_thoughts = saved.thoughts;
    }
}

async function providerSafeGenerate({ prompt, schema, responseLength }) {
    const contract = schemaContract(schema);
    const fullPrompt = `${prompt}\n\nOUTPUT CONTRACT:\nReturn exactly one valid JSON object matching this JSON Schema. Do not use markdown fences, prose, XML, comments, or trailing text.\n${contract}`;

    // No provider-specific response_format / json_schema field is sent here.
    // This works with OpenRouter, custom OpenAI-compatible endpoints, text completion,
    // KoboldCpp, llama.cpp, Claude proxies, Gemini proxies, and models that reject
    // native structured-output parameters with HTTP 400.
    const result = await withJsonBias(() => generateRaw({
        prompt: fullPrompt,
        systemPrompt: 'You are a deterministic roleplay world-state engine. Output JSON only.',
        responseLength,
        trimNames: false,
    }));
    return parseJson(result);
}

async function structuredGenerate({ prompt, schema, responseLength }) {
    const s = settings();

    // Native structured output is optional because many otherwise functional models
    // reject response_format/json_schema and cause SillyTavern to show “Bad Request”.
    if (s.nativeStructuredOutput) {
        try {
            const result = await withJsonBias(() => generateRaw({
                prompt,
                systemPrompt: 'Return only the requested JSON object. No markdown and no commentary.',
                responseLength,
                jsonSchema: schema,
                trimNames: false,
            }));
            return parseJson(result);
        } catch (error) {
            console.warn('[Immersive Worlds] Native structured output rejected; retrying in provider-safe mode.', error);
        }
    }

    try {
        return await providerSafeGenerate({ prompt, schema, responseLength });
    } catch (firstError) {
        console.warn('[Immersive Worlds] Provider-safe JSON generation retry', firstError);
        // Some minimal/custom endpoints reject separate system messages. The final retry
        // folds every instruction into one user prompt, sends no special API fields,
        // and grants extra headroom in case the first pass was truncated mid-JSON.
        const result = await withJsonBias(() => generateRaw({
            prompt: `You are a deterministic roleplay world-state engine.\n${prompt}\n\nReturn exactly one valid JSON object matching this schema and nothing else:\n${schemaContract(schema)}`,
            systemPrompt: '',
            responseLength: Math.min(8192, Math.ceil(responseLength * 1.5)),
            trimNames: false,
        }));
        return parseJson(result);
    }
}

function advanceClock(clock, minutes) {
    const amount = Math.max(0, Math.min(10080, Number(minutes) || 0));
    const [h, m] = String(clock.time || '09:00').split(':').map(Number);
    const total = (Number(clock.day || 1) - 1) * 1440 + (h || 0) * 60 + (m || 0) + amount;
    clock.day = Math.floor(total / 1440) + 1;
    const dayMinutes = total % 1440;
    clock.time = `${String(Math.floor(dayMinutes / 60)).padStart(2, '0')}:${String(dayMinutes % 60).padStart(2, '0')}`;
}

function upsert(collection, value, defaults = {}) {
    if (!value || typeof value !== 'object') return;
    const id = slug(value.id || value.name, 'entity');
    const index = collection.findIndex(x => x.id === id || (value.name && x.name?.toLowerCase() === String(value.name).toLowerCase()));
    if (index >= 0) collection[index] = { ...collection[index], ...value, id: collection[index].id };
    else collection.push({ ...defaults, ...value, id });
}

function applyPatch(state, patch) {
    const s = settings();
    advanceClock(state.clock, patch.time_minutes);
    if (patch.weather) state.clock.weather = String(patch.weather).slice(0, 100);
    if (patch.ambient) state.scene.ambient = String(patch.ambient).trim().slice(0, 500);

    if (s.allowNewCharacters) {
        for (const npc of normalizeArray(patch.new_npcs)) {
            upsert(state.npcs, npc, { locationId: state.currentLocationId, status: 'active', firstSeen: nowIso(), lastSeen: nowIso() });
        }
    }
    for (const npc of normalizeArray(patch.npc_updates)) upsert(state.npcs, npc);

    if (s.allowNewItems) {
        for (const item of normalizeArray(patch.new_items)) {
            upsert(state.items, item, { locationId: state.currentLocationId, quantity: 1, rarity: 'ordinary' });
        }
    }
    for (const item of normalizeArray(patch.item_updates)) upsert(state.items, item);

    if (s.allowNewLocations) {
        for (const loc of normalizeArray(patch.new_locations)) {
            upsert(state.locations, loc, { discovered: true, connections: [], danger: 'unknown' });
        }
    }
    for (const loc of normalizeArray(patch.location_updates)) upsert(state.locations, loc);

    // Auto-link freshly created locations both ways so new points of interest
    // are immediately reachable from the current scene (and vice versa).
    const createdLocs = normalizeArray(patch.new_locations).filter(Boolean);
    if (createdLocs.length) {
        const here = currentLocation(state);
        for (const raw of createdLocs) {
            const id = slug(raw.id || raw.name, 'location');
            const existing = state.locations.find(x => x.id === id);
            if (!existing) continue;
            if (here && here.id !== existing.id) {
                if (!existing.connections.includes(here.id)) existing.connections.push(here.id);
                if (!here.connections.includes(existing.id)) here.connections.push(existing.id);
            }
        }
    }

    for (const faction of normalizeArray(patch.new_factions)) upsert(state.factions, faction, { status: 'active' });
    for (const faction of normalizeArray(patch.faction_updates)) upsert(state.factions, faction);
    for (const event of normalizeArray(patch.new_events)) upsert(state.events, event, { status: 'active', createdAt: nowIso() });
    for (const event of normalizeArray(patch.event_updates)) upsert(state.events, event);
    for (const quest of normalizeArray(patch.new_quests)) upsert(state.quests, quest, { status: 'active', createdAt: nowIso() });
    for (const quest of normalizeArray(patch.quest_updates)) upsert(state.quests, quest);

    const requestedLocation = slug(patch.current_location_id || '', 'location');
    if (requestedLocation && state.locations.some(x => x.id === requestedLocation)) state.currentLocationId = requestedLocation;

    const chronicle = normalizeArray(patch.chronicle);
    if (patch.summary && !chronicle.length) chronicle.push(patch.summary);
    for (const text of chronicle) {
        if (String(text).trim()) state.chronicle.push({ at: nowIso(), text: String(text).trim().slice(0, 700) });
    }
    state.meta.tick = Number(state.meta.tick || 0) + 1;
    state.meta.updatedAt = nowIso();
    const normalized = normalizeState(state);
    normalized.npcs = normalized.npcs.slice(-Number(s.maxNpcs || 48));
    normalized.items = normalized.items.slice(-Number(s.maxItems || 80));
    normalized.locations = normalized.locations.slice(-Number(s.maxLocations || 36));
    return normalized;
}

async function runDirector(chat, force = false) {
    const s = settings();
    const state = getState();
    if (!s.enabled || !s.autoDirector || directorBusy) return state;
    const signature = messageSignature(chat);
    if (!force && signature === state.meta.lastProcessedSignature) return state;
    if (!force && Number(state.meta.tick || 0) % Math.max(1, Number(s.directorEvery) || 1) !== 0) {
        state.meta.tick += 1;
        state.meta.lastProcessedSignature = signature;
        scheduleSave();
        return state;
    }

    directorBusy = true;
    setDirectorStatus(true);
    try {
        const prompt = `Update a persistent roleplay world after reading the latest scene.
Do not write story prose. Produce only a state patch. Preserve established facts unless the transcript explicitly changes them. Infer reasonable time passage. Never invent actions or decisions for the user.
Materialize the world actively: when the scene implies an object (a key, ledger, weapon, letter, goods), a place (a shopfront, door, district, landmark, off-screen destination), or a person (a mentioned name, a passerby with a role), create it now — do not wait for a second mention. Give new locations a connection to the current location. Give new items an owner or a location. Keep new characters distinct and motivated. Let active events and rumors evolve between passes. Be generous within plausibility: a living city is full of small things. Keep off-screen change causally justified and restrained.

WORLD LORE / ACTIVE CHARACTER:
${currentCharacterSummary()}

CURRENT STATE:
${JSON.stringify(conciseState(state))}

SCENE BRIEF (current atmosphere — keep it consistent):
${buildSceneBrief(state)}

SIMULATION POLICY:
Detail level: ${s.simulationDetail}. Off-screen events: ${s.allowOffscreenEvents ? 'allowed when restrained and causally justified' : 'disabled; update only what the transcript directly establishes'}. Dynamic characters: ${s.allowNewCharacters ? 'allowed' : 'disabled'}. Dynamic items: ${s.allowNewItems ? 'allowed' : 'disabled'}. Dynamic places: ${s.allowNewLocations ? 'allowed' : 'disabled'}.
Growth budget: when the scene implies them, add up to ${s.simulationDetail === 'maximum' ? 3 : s.simulationDetail === 'high' ? 2 : 1} new item(s), ${s.simulationDetail === 'maximum' ? 2 : 1} new location(s), ${s.simulationDetail === 'maximum' ? 2 : 1} new NPC(s), and 1 new event per pass.

RECENT TRANSCRIPT:
${JSON.stringify(recentTranscript(chat, 10))}

Patch field guidance:
- IDs are lowercase stable slugs.
- Updates must include id.
- New NPCs need name, role, personality, appearance, goals, relationship, locationId, status.
- New items need name, type, description, rarity, quantity, ownerId or locationId, properties.
- ambient is 1-2 vivid sensory sentences for the current scene: light, weather, smell, sound, texture, mood. Concrete, not generic.
- Chronicle contains 0-3 terse factual continuity notes.
- time_minutes is elapsed scene time, usually 0-180.`;
        const patch = await structuredGenerate({ prompt, schema: directorSchema, responseLength: clampBudget(Number(s.directorTokens) || 3000, 1000, 8192) });
        const next = applyPatch(state, patch);
        consecutiveDirectorFailures = 0;
        next.meta.lastProcessedSignature = signature;
        const ctx = getContext();
        ctx.chatMetadata[STATE_KEY] = next;
        injectState(next);
        scheduleSave();
        renderPanel();
        return next;
    } catch (error) {
        consecutiveDirectorFailures += 1;
        console.error('[Immersive Worlds] Director pass failed', error);

        const rejected = isRequestRejection(error);
        if (rejected && settings().suspendDirectorOnApiError) {
            settings().autoDirector = false;
            saveSettingsDebounced();
            syncSettingsUi();
            toastr.error('The API rejected the background director request, so Automatic State Director was disabled. The living-world prompt engine remains active and normal roleplay can continue.', 'Immersive Worlds');
        } else {
            toastr.warning(`Living-world director skipped this turn: ${errorText(error).slice(0, 180)}`, 'Immersive Worlds');
        }

        injectState(state);
        return state;
    } finally {
        directorBusy = false;
        setDirectorStatus(false);
    }
}

async function bootstrapWorld() {
    const ctx = getContext();
    if (!ctx?.chatId && ctx?.characterId === undefined && !ctx?.groupId) {
        toastr.warning('Open a character or group chat first.');
        return;
    }
    setDirectorStatus(true, 'Building city…');
    directorBusy = true;
    try {
        const s = settings();
        const prompt = `Create a compact but vivid persistent roleplay world from the supplied lore. The result must support an explorable city or settlement with independent residents, useful objects, social tensions, and room to expand naturally.
Do not overwrite the user persona or decide their history. Seed 5-10 locations with sensible connections, 6-12 NPCs with distinct roles and motives, 6-14 interactable items, 2-4 factions if appropriate, and 1-3 active events. Use stable lowercase slug IDs. Put only currently present characters at the starting location. Avoid generic fantasy filler unless the lore calls for it.

SOURCE LORE:\n${currentCharacterSummary()}

RECENT CHAT:\n${JSON.stringify(recentTranscript(ctx.chat, 8))}`;
        const generated = await structuredGenerate({ prompt, schema: bootstrapSchema, responseLength: clampBudget(Number(s.bootstrapTokens) || 6000, 2000, 8192) });
        const state = normalizeState({ ...baseWorld(), ...generated, chronicle: [{ at: nowIso(), text: 'The living world was generated from the active lore.' }], meta: { createdAt: nowIso(), updatedAt: nowIso(), tick: 0, lastProcessedSignature: '' } });
        consecutiveDirectorFailures = 0;
        ctx.chatMetadata[STATE_KEY] = state;
        injectState(state);
        await ctx.saveMetadata();
        renderPanel();
        toastr.success(`${state.worldName} is now live.`, 'Immersive Worlds');
    } catch (error) {
        console.error('[Immersive Worlds] World generation failed', error);
        toastr.error(`Could not generate the city: ${errorText(error).slice(0, 180)}`, 'Immersive Worlds');
    } finally {
        directorBusy = false;
        setDirectorStatus(false);
    }
}

function setDirectorStatus(busy, label = 'Director thinking…') {
    $('#iw-director-status').toggleClass('active', busy).text(busy ? label : 'World synchronized');
    $('#iw-generate-world, #iw-run-director').prop('disabled', busy);
}

function escapeHtml(value) {
    return $('<div>').text(String(value ?? '')).html();
}

function entityEmpty(label) {
    return `<div class="iw-empty">${escapeHtml(label)}</div>`;
}

function worldTab(state) {
    const loc = currentLocation(state);
    const connections = (loc?.connections || []).map(id => state.locations.find(x => x.id === id)).filter(Boolean);
    const weatherIcon = WEATHER_ICONS[String(state.clock.weather || '').toLowerCase().replace(/[^a-z]+/g, '')] || 'fa-cloud-sun';
    const locations = state.locations.map(x => `
        <button class="iw-location-card ${x.id === state.currentLocationId ? 'active' : ''}" data-location="${escapeHtml(x.id)}">
            <span class="iw-location-type">${escapeHtml(x.type)}</span>
            <strong>${escapeHtml(x.name)}</strong>
            <small>${escapeHtml(x.description)}</small>
        </button>`).join('');
    return `
        <section class="iw-hero">
            <div>
                <span class="iw-kicker"><i class="fa-solid ${weatherIcon} iw-weather-icon"></i> DAY ${escapeHtml(state.clock.day)} · ${escapeHtml(state.clock.time)} · ${escapeHtml(state.clock.weather)}</span>
                <h2>${escapeHtml(state.worldName)}</h2>
                <p>${escapeHtml(state.premise || 'A persistent world is taking shape around the conversation.')}</p>
            </div>
            <div class="iw-clock-orb" title="World clock"><span>${escapeHtml(state.clock.time)}</span></div>
        </section>
        <section class="iw-atmosphere">
            <span class="iw-kicker"><i class="fa-solid fa-wind"></i> Atmosphere</span>
            <p>${escapeHtml(atmosphereLine(state))}</p>
        </section>
        <section class="iw-current-location">
            <div class="iw-section-title"><span>Current location</span><button id="iw-edit-world" class="menu_button iw-mini"><i class="fa-solid fa-pen"></i></button></div>
            <h3>${escapeHtml(loc?.name || 'Unknown')}</h3>
            <p>${escapeHtml(loc?.description || '')}</p>
            <div class="iw-chip-row">${connections.length ? connections.map(x => `<button class="iw-chip iw-travel" data-location="${escapeHtml(x.id)}"><i class="fa-solid fa-route"></i> ${escapeHtml(x.name)}</button>`).join('') : '<span class="iw-muted">No mapped exits yet.</span>'}</div>
        </section>
        <section>
            <div class="iw-section-title"><span>Known places</span><span>${state.locations.length}</span></div>
            <div class="iw-location-grid">${locations}</div>
        </section>`;
}

function peopleTab(state) {
    const here = state.npcs.filter(n => n.locationId === state.currentLocationId);
    const elsewhere = state.npcs.filter(n => n.locationId !== state.currentLocationId);
    const cards = list => list.map(n => {
        const loc = state.locations.find(x => x.id === n.locationId);
        return `<article class="iw-entity-card">
            <div class="iw-avatar-sigil">${escapeHtml(n.name.slice(0, 2).toUpperCase())}</div>
            <div class="iw-entity-main">
                <div class="iw-entity-heading"><strong>${escapeHtml(n.name)}</strong><span>${escapeHtml(n.status)}</span></div>
                <small>${escapeHtml(n.role)} · ${escapeHtml(loc?.name || 'Unknown')}</small>
                <p>${escapeHtml(n.personality || n.appearance || 'Not yet known.')}</p>
                <div class="iw-card-actions">
                    <button class="menu_button iw-mini iw-focus-npc" data-id="${escapeHtml(n.id)}"><i class="fa-solid fa-eye"></i> Inspect</button>
                    <button class="menu_button iw-mini iw-materialize" data-id="${escapeHtml(n.id)}" ${n.materializedAvatar ? 'disabled' : ''}><i class="fa-solid fa-id-card"></i> ${n.materializedAvatar ? 'Card created' : 'Create card'}</button>
                </div>
            </div>
        </article>`;
    }).join('');
    return `<section>
        <div class="iw-section-title"><span>Present now</span><button id="iw-add-npc" class="menu_button iw-mini"><i class="fa-solid fa-user-plus"></i> Add</button></div>
        <div class="iw-entity-list">${here.length ? cards(here) : entityEmpty('Nobody else is currently recorded here.')}</div>
        <div class="iw-section-title iw-spaced"><span>Elsewhere in the world</span><span>${elsewhere.length}</span></div>
        <div class="iw-entity-list">${elsewhere.length ? cards(elsewhere) : entityEmpty('The wider cast will emerge as the world grows.')}</div>
    </section>`;
}

function itemsTab(state) {
    const inventory = new Set(state.player.inventoryIds || []);
    const cards = state.items.map(item => {
        const owner = state.npcs.find(n => n.id === item.ownerId);
        const loc = state.locations.find(l => l.id === item.locationId);
        return `<article class="iw-item-card">
            <div class="iw-item-icon"><i class="fa-solid fa-cube"></i></div>
            <div><div class="iw-entity-heading"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.rarity)}</span></div>
            <small>${escapeHtml(item.type)} · ${escapeHtml(owner ? `Owned by ${owner.name}` : inventory.has(item.id) ? 'In your inventory' : loc?.name || 'Unknown')}</small>
            <p>${escapeHtml(item.description)}</p></div>
        </article>`;
    }).join('');
    return `<section>
        <div class="iw-section-title"><span>Objects & inventory</span><button id="iw-add-item" class="menu_button iw-mini"><i class="fa-solid fa-plus"></i> Add</button></div>
        <div class="iw-entity-list">${cards || entityEmpty('Items created by the story will appear here.')}</div>
    </section>`;
}

function timelineTab(state) {
    const events = [...state.events].reverse().map(e => `<article class="iw-timeline-entry"><span></span><div><strong>${escapeHtml(e.name || e.title || 'World event')}</strong><p>${escapeHtml(e.description || e.summary || e.status || '')}</p></div></article>`).join('');
    const chronicle = [...state.chronicle].reverse().map(e => `<article class="iw-timeline-entry"><span></span><div><strong>${escapeHtml(new Date(e.at || Date.now()).toLocaleString())}</strong><p>${escapeHtml(e.text)}</p></div></article>`).join('');
    return `<section>
        <div class="iw-section-title"><span>Active world events</span><span>${state.events.length}</span></div>
        <div class="iw-timeline">${events || entityEmpty('No active events recorded.')}</div>
        <div class="iw-section-title iw-spaced"><span>Chronicle</span><span>${state.chronicle.length}</span></div>
        <div class="iw-timeline">${chronicle || entityEmpty('The chronicle is empty.')}</div>
    </section>`;
}

function settingsTab() {
    const s = settings();
    return `<section class="iw-panel-settings">
        <div class="iw-section-title"><span>Simulation controls</span></div>
        <label><span>Living-world engine</span><input id="iw-panel-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}></label>
        <label><span>Automatic director pass</span><input id="iw-panel-auto" type="checkbox" ${s.autoDirector ? 'checked' : ''}></label>
        <label><span>Immersive visual layer</span><input id="iw-panel-theme" type="checkbox" ${s.immersiveTheme ? 'checked' : ''}></label>
        <label><span>Ambient effects</span><input id="iw-panel-ambient" type="checkbox" ${s.ambientEffects ? 'checked' : ''}></label>
        <div class="iw-button-grid">
            <button id="iw-run-director" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> Director pass</button>
            <button id="iw-generate-world" class="menu_button"><i class="fa-solid fa-city"></i> Regenerate world</button>
            <button id="iw-export" class="menu_button"><i class="fa-solid fa-file-export"></i> Export JSON</button>
            <button id="iw-import" class="menu_button"><i class="fa-solid fa-file-import"></i> Import JSON</button>
            <button id="iw-reset" class="menu_button danger_button"><i class="fa-solid fa-trash"></i> Reset world</button>
        </div>
        <input id="iw-import-file" type="file" accept="application/json" hidden>
        <p class="iw-footnote">World data is stored inside the current chat metadata. Each chat can maintain a different city and timeline.</p>
    </section>`;
}

function renderPanel() {
    const state = getState();
    const body = $('#iw-panel-body');
    if (!body.length) return;
    const html = activeTab === 'world' ? worldTab(state)
        : activeTab === 'people' ? peopleTab(state)
            : activeTab === 'items' ? itemsTab(state)
                : activeTab === 'timeline' ? timelineTab(state)
                    : settingsTab();
    body.html(html);
    $('#iw-panel-tabs button').removeClass('active').filter(`[data-tab="${activeTab}"]`).addClass('active');
    bindPanelEvents();
    updateAmbientState(state);
}

function bindPanelEvents() {
    $('#iw-panel-tabs button').off('click').on('click', function () {
        activeTab = String($(this).data('tab'));
        renderPanel();
    });
    $('.iw-location-card, .iw-travel').off('click').on('click', function () {
        travelTo(String($(this).data('location')));
    });
    $('#iw-run-director').off('click').on('click', () => runDirector(getContext()?.chat || [], true));
    $('#iw-generate-world').off('click').on('click', bootstrapWorld);
    $('#iw-reset').off('click').on('click', resetWorld);
    $('#iw-export').off('click').on('click', exportWorld);
    $('#iw-import').off('click').on('click', () => $('#iw-import-file').trigger('click'));
    $('#iw-import-file').off('change').on('change', importWorld);
    $('#iw-add-npc').off('click').on('click', addNpcManual);
    $('#iw-add-item').off('click').on('click', addItemManual);
    $('.iw-focus-npc').off('click').on('click', function () { inspectNpc(String($(this).data('id'))); });
    $('.iw-materialize').off('click').on('click', function () { materializeNpc(String($(this).data('id'))); });
    $('#iw-edit-world').off('click').on('click', editWorldPremise);
    $('#iw-panel-enabled').off('change').on('change', function () { updateSetting('enabled', this.checked); injectState(); });
    $('#iw-panel-auto').off('change').on('change', function () { updateSetting('autoDirector', this.checked); });
    $('#iw-panel-theme').off('change').on('change', function () { updateSetting('immersiveTheme', this.checked); applyTheme(); });
    $('#iw-panel-ambient').off('change').on('change', function () { updateSetting('ambientEffects', this.checked); updateAmbientState(getState()); });
}

function updateSetting(key, value) {
    settings()[key] = value;
    saveSettingsDebounced();
}

function travelTo(id) {
    const state = getState();
    const target = state.locations.find(x => x.id === id);
    if (!target || target.id === state.currentLocationId) return;
    const from = currentLocation(state);
    state.currentLocationId = target.id;
    advanceClock(state.clock, 15);
    state.chronicle.push({ at: nowIso(), text: `Travelled from ${from?.name || 'an unknown place'} to ${target.name}.` });
    state.meta.lastProcessedSignature = '';
    injectState(state);
    scheduleSave();
    renderPanel();
    toastr.info(`Current location: ${target.name}`, 'Immersive Worlds');
}

async function promptFields(title, fields) {
    const controls = fields.map(f => `<label class="iw-dialog-field"><span>${escapeHtml(f.label)}</span>${f.type === 'textarea' ? `<textarea data-field="${escapeHtml(f.key)}" rows="4">${escapeHtml(f.value || '')}</textarea>` : `<input data-field="${escapeHtml(f.key)}" value="${escapeHtml(f.value || '')}">`}</label>`).join('');
    const content = $(`<div class="iw-dialog"><h3>${escapeHtml(title)}</h3>${controls}</div>`);
    const result = await getContext().callGenericPopup(content.get(0), getContext().POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel', allowVerticalScrolling: true, wide: true });
    if (!result) return null;
    return Object.fromEntries(fields.map(f => [f.key, String(content.find(`[data-field="${f.key}"]`).val() || '').trim()]));
}

async function addNpcManual() {
    const values = await promptFields('Add a world character', [
        { key: 'name', label: 'Name' },
        { key: 'role', label: 'Role' },
        { key: 'personality', label: 'Personality', type: 'textarea' },
        { key: 'appearance', label: 'Appearance', type: 'textarea' },
    ]);
    if (!values?.name) return;
    const state = getState();
    state.npcs.push({ id: uniqueId(state.npcs, values.name, 'npc'), ...values, goals: [], relationship: 'Newly introduced', locationId: state.currentLocationId, status: 'present', secrets: [], inventory: [], firstSeen: nowIso(), lastSeen: nowIso(), materializedAvatar: '' });
    state.chronicle.push({ at: nowIso(), text: `${values.name} entered the living-world roster.` });
    injectState(state); scheduleSave(); renderPanel();
}

async function addItemManual() {
    const values = await promptFields('Add an item', [
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Type' },
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'rarity', label: 'Rarity', value: 'ordinary' },
    ]);
    if (!values?.name) return;
    const state = getState();
    state.items.push({ id: uniqueId(state.items, values.name, 'item'), ...values, quantity: 1, ownerId: '', locationId: state.currentLocationId, properties: [] });
    state.chronicle.push({ at: nowIso(), text: `${values.name} was added at ${currentLocation(state)?.name}.` });
    injectState(state); scheduleSave(); renderPanel();
}

async function inspectNpc(id) {
    const state = getState();
    const n = state.npcs.find(x => x.id === id);
    if (!n) return;
    const loc = state.locations.find(x => x.id === n.locationId);
    const content = `<div class="iw-npc-detail"><h2>${escapeHtml(n.name)}</h2><div class="iw-chip-row"><span class="iw-chip">${escapeHtml(n.role)}</span><span class="iw-chip">${escapeHtml(n.status)}</span><span class="iw-chip">${escapeHtml(loc?.name || 'Unknown')}</span></div><h4>Appearance</h4><p>${escapeHtml(n.appearance || 'Unknown')}</p><h4>Personality</h4><p>${escapeHtml(n.personality || 'Unknown')}</p><h4>Relationship</h4><p>${escapeHtml(n.relationship || 'Unknown')}</p><h4>Goals</h4><p>${escapeHtml((n.goals || []).join(' · ') || 'Unknown')}</p></div>`;
    await getContext().callGenericPopup(content, getContext().POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wide: true });
}

async function materializeNpc(id) {
    const state = getState();
    const npc = state.npcs.find(x => x.id === id);
    if (!npc || npc.materializedAvatar) return;
    const form = new FormData();
    form.set('ch_name', npc.name);
    form.set('description', npc.appearance || `${npc.name} is ${npc.role}.`);
    form.set('personality', npc.personality || 'Defined by the living world.');
    form.set('scenario', `${npc.name} exists in ${state.worldName}. Current role: ${npc.role}. Relationship: ${npc.relationship}.`);
    form.set('first_mes', `*${npc.name} notices {{user}} nearby.*`);
    form.set('mes_example', '');
    form.set('creator_notes', `Generated from Immersive Worlds in ${state.worldName}.`);
    form.set('creator', 'Immersive Worlds');
    form.set('tags', `Immersive Worlds, ${state.worldName}`);
    form.set('talkativeness', '0.5');
    form.set('extensions', JSON.stringify({ immersive_worlds: { sourceWorld: state.worldName, npcId: npc.id } }));
    form.set('fav', 'false');
    try {
        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: form,
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`Character creation failed (${response.status})`);
        npc.materializedAvatar = await response.text();
        scheduleSave(); renderPanel();
        toastr.success(`${npc.name} is now a reusable SillyTavern character card.`, 'Immersive Worlds');
    } catch (error) {
        console.error(error);
        toastr.error(`Could not create a character card for ${npc.name}.`, 'Immersive Worlds');
    }
}

async function editWorldPremise() {
    const state = getState();
    const values = await promptFields('Edit world identity', [
        { key: 'worldName', label: 'World name', value: state.worldName },
        { key: 'premise', label: 'Premise', value: state.premise, type: 'textarea' },
        { key: 'tone', label: 'Tone', value: state.tone },
    ]);
    if (!values) return;
    Object.assign(state, values);
    injectState(state); scheduleSave(); renderPanel();
}

async function resetWorld() {
    const yes = await getContext().callGenericPopup('Reset the living world for this chat? This removes its generated locations, NPCs, items, and timeline.', getContext().POPUP_TYPE.CONFIRM);
    if (!yes) return;
    getContext().chatMetadata[STATE_KEY] = baseWorld();
    injectState(); await getContext().saveMetadata(); renderPanel();
}

function exportWorld() {
    const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(getState().worldName, 'living-world')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

async function importWorld(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        const data = normalizeState(JSON.parse(await file.text()));
        getContext().chatMetadata[STATE_KEY] = data;
        injectState(data); await getContext().saveMetadata(); renderPanel();
        toastr.success(`${data.worldName} imported.`, 'Immersive Worlds');
    } catch (error) {
        toastr.error('That file is not a valid Immersive Worlds state.');
    } finally {
        event.target.value = '';
    }
}

function updateAmbientState(state) {
    const s = settings();
    document.body.classList.toggle('iw-theme-enabled', Boolean(s.immersiveTheme));
    document.body.classList.toggle('iw-ambient-enabled', Boolean(s.immersiveTheme && s.ambientEffects));
    const [hour] = String(state?.clock?.time || '12:00').split(':').map(Number);
    document.body.dataset.iwTime = hour < 6 ? 'night' : hour < 10 ? 'dawn' : hour < 18 ? 'day' : hour < 21 ? 'dusk' : 'night';
    document.body.dataset.iwWeather = slug(state?.clock?.weather || 'clear', 'clear');
    $('#iw-location-label').text(currentLocation(state)?.name || 'No active world');
}

function applyTheme() {
    updateAmbientState(getState());
}

async function createUi() {
    if (!$(`#${PANEL_ID}`).length) {
        const html = await renderExtensionTemplateAsync('third-party/ImmersiveWorlds', 'panel');
        $('body').append(html);
    }
    if (!$(`#${SETTINGS_ID}`).length) {
        const html = await renderExtensionTemplateAsync('third-party/ImmersiveWorlds', 'settings');
        const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        target.append(html);
    }
    bindStaticEvents();
    syncSettingsUi();
    renderPanel();
}

function bindStaticEvents() {
    $('#iw-open-panel, #iw-floating-button').off('click').on('click', () => {
        $(`#${PANEL_ID}`).toggleClass('open');
        renderPanel();
    });
    $('#iw-close-panel').off('click').on('click', () => $(`#${PANEL_ID}`).removeClass('open'));
    $('#iw-panel-backdrop').off('click').on('click', () => $(`#${PANEL_ID}`).removeClass('open'));
    $('[data-iw-setting]').off('change input').on('change input', function () {
        const key = String($(this).data('iw-setting'));
        const value = this.type === 'checkbox' ? this.checked : this.type === 'number' ? Number(this.value) : this.value;
        updateSetting(key, value);
        applyTheme();
        syncSettingsUi();
        injectState();
    });
}

function syncSettingsUi() {
    const s = settings();
    $('[data-iw-setting]').each(function () {
        const key = String($(this).data('iw-setting'));
        if (this.type === 'checkbox') this.checked = Boolean(s[key]);
        else $(this).val(s[key]);
    });
    $('#iw-floating-button').toggle(Boolean(s.showFloatingButton));
    applyTheme();
}

async function onChatChanged() {
    getState();
    injectState();
    renderPanel();
}

async function onMessageChanged() {
    const state = getState();
    state.meta.lastProcessedSignature = '';
    injectState(state);
    renderPanel();
}

globalThis.immersiveWorldsGenerationInterceptor = async function (chat) {
    const state = getState();
    injectState(state);
    if (!settings().enabled || !settings().autoDirector) return;
    const last = chat?.[chat.length - 1];
    if (!last?.is_user) return;
    await runDirector(chat, false);
};

export async function init() {
    if (initialized) return;
    initialized = true;
    settings();
    await createUi();
    getState();
    injectState();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageChanged);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageChanged);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageChanged);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => renderPanel());
    console.info('[Immersive Worlds] Living Cities initialized');
}
