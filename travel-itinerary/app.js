// ============================================================
// Travel Itinerary Planner – main application logic
// ============================================================

const API_URL = "https://api.anthropic.com/v1/messages";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = {
    apiKey: "",
    model: "claude-sonnet-4-6",
    conversationHistory: [],
    currentItineraryMd: "",
    isGenerating: false,
    tripParams: null,
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(params) {
    const today = new Date().toISOString().split("T")[0];
    return `You are an elite travel concierge and itinerary planner. Today's date is ${today}.
Your job is to create comprehensive, beautifully structured travel itineraries that feel like they were crafted by a luxury travel agent.

TRIP DETAILS:
- Destinations: ${params.destinations}
- Dates: ${params.startDate || "flexible"} to ${params.endDate || "flexible"}
- Duration: ${params.days} days
- Travelers: ${params.travelers}
- Departing from: ${params.departureCity || "not specified"}
- Budget level: ${params.budget}
- Interests/preferences: ${params.preferences || "none specified"}

INSTRUCTIONS:

You MUST use the web_search tool to find CURRENT, ACCURATE information. Do NOT rely on training data alone. Search for:
- Current top-rated attractions and their hours/prices
- Highly-rated restaurants (recent reviews)
- Top-rated PRIVATE tours on Viator and GetYourGuide (search each separately)
- Lodging options across multiple platforms
- Flight routes and carriers

Structure your itinerary with these sections in this order:

## Trip Overview
Brief summary of the trip with highlights.

## Flights
- Research actual flight routes from ${params.departureCity || "the traveler's home city"} to the destination(s) and back.
- Recommend specific airlines and route options.
- Note if business class is within ~30-40% of economy price.
- Include these booking links:
  - Google Flights: build a link like https://www.google.com/travel/flights?q=flights+from+ORIGIN+to+DEST
  - Kayak: https://www.kayak.com/flights/ORIGIN-DEST/YYYY-MM-DD

## Lodging
For EACH destination/city, provide options from these categories:
1. **Inspirato Pass** – Search for Inspirato luxury properties in the area. Link: https://www.inspirato.com/
2. **VRBO** – Top-rated vacation rentals. Build search link: https://www.vrbo.com/search?destination=DESTINATION
3. **Airbnb** – Top-rated stays. Build search link: https://www.airbnb.com/s/DESTINATION/homes
4. **American Express Fine Hotels & Resorts** – Search for FHR properties. Link: https://www.americanexpress.com/en-us/travel/fine-hotels-resorts/

Include specific property recommendations where possible with approximate nightly rates.

## Day-by-Day Itinerary
For EACH day, use this format:

### Day X: [Date if known] – [Theme/Title]

**Morning**
- Activity with specific details (address, hours, cost)
- Why it's worth visiting

**Lunch**
- Restaurant name, cuisine type, price range
- Must-try dishes
- Reservation link if available

**Afternoon**
- Activity/attraction details
- Include any recommended private tours with:
  - Tour name and operator
  - Viator link: https://www.viator.com/searchResults/all?text=SEARCH+TERMS
  - GetYourGuide link: https://www.getyourguide.com/s?q=SEARCH+TERMS
  - Only recommend tours rated 4.5+ stars
  - Note "Private tour" explicitly

**Dinner**
- Restaurant recommendation with details
- Price range per person

**Evening** (optional)
- Night activity, show, bar, or relaxation suggestion

**Getting around**: Transportation tips for the day.

## Top Private Tours & Excursions
Consolidated list of the best private tours across the trip:
- Tour name, operator, approximate price
- Rating (4.5+ stars only)
- Direct booking links to Viator and/or GetYourGuide

## Budget Estimate
| Category | Estimated Cost |
|----------|---------------|
| Flights | $X,XXX |
| Lodging (X nights) | $X,XXX |
| Food & Dining | $X,XXX |
| Activities & Tours | $X,XXX |
| Transportation (local) | $XXX |
| **Total** | **$XX,XXX** |

Per person and total for ${params.travelers} travelers.

## Travel Tips
- Visa requirements, currency, tipping customs
- Packing suggestions for the season
- Safety tips
- Useful apps and phrases

FORMATTING RULES:
- Use clean Markdown with headers, bullet points, bold text, and tables.
- All links should be actual clickable URLs (not placeholders).
- Use emoji sparingly and tastefully for section headers only.
- Be specific – include real place names, addresses where possible, real prices.
- When the user asks to modify the itinerary, regenerate the COMPLETE updated itinerary (all sections) with the requested changes incorporated.`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function loadSettings() {
    state.apiKey = localStorage.getItem("tp_apiKey") || "";
    state.model = localStorage.getItem("tp_model") || "claude-sonnet-4-6";
}

function saveSettings() {
    const key = document.getElementById("api-key-input").value.trim();
    const model = document.getElementById("model-select").value;
    if (!key) {
        alert("Please enter your Anthropic API key.");
        return;
    }
    state.apiKey = key;
    state.model = model;
    localStorage.setItem("tp_apiKey", key);
    localStorage.setItem("tp_model", model);
    document.getElementById("settings-modal").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
}

function openSettings() {
    document.getElementById("api-key-input").value = state.apiKey;
    document.getElementById("model-select").value = state.model;
    document.getElementById("settings-modal").classList.remove("hidden");
}

function toggleKeyVisibility() {
    const inp = document.getElementById("api-key-input");
    const btn = inp.nextElementSibling;
    if (inp.type === "password") {
        inp.type = "text";
        btn.textContent = "Hide";
    } else {
        inp.type = "password";
        btn.textContent = "Show";
    }
}

// ---------------------------------------------------------------------------
// Trip form
// ---------------------------------------------------------------------------
function handleTripSubmit(e) {
    e.preventDefault();
    if (state.isGenerating) return;

    const destinations = document.getElementById("destinations").value.trim();
    const startDate = document.getElementById("start-date").value;
    const endDate = document.getElementById("end-date").value;
    let days = parseInt(document.getElementById("trip-days").value) || 0;
    const travelers = parseInt(document.getElementById("travelers").value) || 2;
    const departureCity = document.getElementById("departure-city").value.trim();
    const budget = document.getElementById("budget").value;
    const preferences = document.getElementById("preferences").value.trim();

    if (!destinations) {
        alert("Please enter at least one destination.");
        return;
    }

    if (startDate && endDate) {
        const d1 = new Date(startDate);
        const d2 = new Date(endDate);
        days = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
    } else if (!days) {
        alert("Please enter dates or number of days.");
        return;
    }

    state.tripParams = { destinations, startDate, endDate, days, travelers, departureCity, budget, preferences };
    state.conversationHistory = [];
    state.currentItineraryMd = "";

    generateItinerary();
}

// ---------------------------------------------------------------------------
// API – streaming call
// ---------------------------------------------------------------------------
async function callClaude(messages, systemPrompt, onText, onStatus) {
    const body = {
        model: state.model,
        max_tokens: 16000,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 15 }],
        stream: true,
        messages: messages,
    };

    const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": state.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errorBody = await resp.text();
        throw new Error(`API error ${resp.status}: ${errorBody}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            let evt;
            try { evt = JSON.parse(data); } catch { continue; }

            if (evt.type === "content_block_start") {
                if (evt.content_block?.type === "server_tool_use" && evt.content_block?.name === "web_search") {
                    const query = evt.content_block?.input?.query || "the web";
                    onStatus(`Searching: ${query}`);
                }
            }

            if (evt.type === "content_block_delta") {
                if (evt.delta?.type === "text_delta" && evt.delta.text) {
                    fullText += evt.delta.text;
                    onText(fullText);
                }
            }

            if (evt.type === "error") {
                throw new Error(evt.error?.message || "Stream error");
            }
        }
    }

    return fullText;
}

// ---------------------------------------------------------------------------
// Generate itinerary
// ---------------------------------------------------------------------------
async function generateItinerary() {
    state.isGenerating = true;
    setFormLoading(true);
    showStatus("Building your itinerary...", "Searching for the best flights, hotels, restaurants, and tours");
    showItinerary();

    const userMessage = buildInitialPrompt(state.tripParams);
    state.conversationHistory = [{ role: "user", content: userMessage }];

    try {
        const systemPrompt = buildSystemPrompt(state.tripParams);
        const result = await callClaude(
            state.conversationHistory,
            systemPrompt,
            (text) => renderItinerary(text),
            (statusMsg) => updateStatusDetail(statusMsg),
        );

        state.currentItineraryMd = result;
        state.conversationHistory.push({ role: "assistant", content: result });
        hideStatus();
        showChat();
    } catch (err) {
        hideStatus();
        alert("Error generating itinerary: " + err.message);
        console.error(err);
    } finally {
        state.isGenerating = false;
        setFormLoading(false);
    }
}

function buildInitialPrompt(p) {
    let prompt = `Please create a detailed travel itinerary for: ${p.destinations}.\n`;
    if (p.startDate && p.endDate) {
        prompt += `Travel dates: ${p.startDate} to ${p.endDate} (${p.days} days).\n`;
    } else {
        prompt += `Duration: ${p.days} days.\n`;
    }
    prompt += `Number of travelers: ${p.travelers}.\n`;
    if (p.departureCity) prompt += `Departing from: ${p.departureCity}.\n`;
    prompt += `Budget level: ${p.budget}.\n`;
    if (p.preferences) prompt += `Our preferences: ${p.preferences}\n`;
    prompt += `\nPlease search the web for current information on flights, hotels, restaurants, tours, and attractions. Include real booking links.`;
    return prompt;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
async function handleChatSubmit(e) {
    e.preventDefault();
    if (state.isGenerating) return;

    const input = document.getElementById("chat-input");
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";

    addChatMessage("user", msg);
    state.conversationHistory.push({ role: "user", content: msg });

    state.isGenerating = true;
    setChatLoading(true);
    showStatus("Updating your itinerary...", "Applying your changes");

    try {
        const systemPrompt = buildSystemPrompt(state.tripParams);
        const result = await callClaude(
            state.conversationHistory,
            systemPrompt,
            (text) => renderItinerary(text),
            (statusMsg) => updateStatusDetail(statusMsg),
        );

        state.currentItineraryMd = result;
        state.conversationHistory.push({ role: "assistant", content: result });
        addChatMessage("assistant", "Itinerary updated! Take a look above.");
        hideStatus();
    } catch (err) {
        addChatMessage("system", "Error: " + err.message);
        hideStatus();
    } finally {
        state.isGenerating = false;
        setChatLoading(false);
    }
}

function addChatMessage(role, text) {
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = `chat-msg ${role}`;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function toggleChat() {
    document.getElementById("chat-container").classList.toggle("chat-collapsed");
}

function showChat() {
    const chat = document.getElementById("chat-container");
    chat.classList.remove("hidden");
    document.body.classList.add("chat-open");
    addChatMessage("system", "Your itinerary is ready! Ask me to make any changes — swap activities, find different hotels, adjust the budget, add rest days, etc.");
}

function setChatLoading(loading) {
    const btn = document.getElementById("chat-send-btn");
    const input = document.getElementById("chat-input");
    btn.disabled = loading;
    input.disabled = loading;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setFormLoading(loading) {
    const btn = document.getElementById("generate-btn");
    btn.querySelector(".btn-text").classList.toggle("hidden", loading);
    btn.querySelector(".btn-loading").classList.toggle("hidden", !loading);
    btn.disabled = loading;
}

function showStatus(title, detail) {
    document.getElementById("search-status").classList.remove("hidden");
    document.getElementById("status-title").textContent = title;
    document.getElementById("status-detail").textContent = detail;
}

function updateStatusDetail(detail) {
    document.getElementById("status-detail").textContent = detail;
}

function hideStatus() {
    document.getElementById("search-status").classList.add("hidden");
}

function showItinerary() {
    document.getElementById("itinerary-section").classList.remove("hidden");
    document.getElementById("itinerary-title").textContent =
        `Your ${state.tripParams.destinations} Itinerary`;
}

function renderItinerary(md) {
    const el = document.getElementById("itinerary-content");
    el.innerHTML = marked.parse(md);
    // Open all links in new tab
    el.querySelectorAll("a").forEach((a) => {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
    });
}

function startNewTrip() {
    state.conversationHistory = [];
    state.currentItineraryMd = "";
    state.tripParams = null;
    document.getElementById("itinerary-section").classList.add("hidden");
    document.getElementById("chat-container").classList.add("hidden");
    document.body.classList.remove("chat-open");
    document.getElementById("chat-messages").innerHTML = "";
    document.getElementById("trip-form").reset();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function exportMarkdown() {
    if (!state.currentItineraryMd) return;
    const blob = new Blob([state.currentItineraryMd], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dest = state.tripParams?.destinations?.replace(/[^a-zA-Z0-9]/g, "_") || "trip";
    a.download = `itinerary_${dest}.md`;
    a.click();
    URL.revokeObjectURL(url);
}

function printItinerary() {
    window.print();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    if (state.apiKey) {
        document.getElementById("settings-modal").classList.add("hidden");
        document.getElementById("app").classList.remove("hidden");
    } else {
        document.getElementById("app").classList.add("hidden");
    }

    // Set min date to today
    const today = new Date().toISOString().split("T")[0];
    const startInput = document.getElementById("start-date");
    const endInput = document.getElementById("end-date");
    startInput.setAttribute("min", today);
    endInput.setAttribute("min", today);
    startInput.addEventListener("change", () => {
        endInput.setAttribute("min", startInput.value);
        if (endInput.value && endInput.value < startInput.value) {
            endInput.value = startInput.value;
        }
    });
});
