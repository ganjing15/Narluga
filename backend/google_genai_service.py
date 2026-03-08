import os
from google import genai
from google.genai import types
from dotenv import load_dotenv
import base64
import asyncio
from fastapi import WebSocket
import io
import aiohttp
from bs4 import BeautifulSoup
from fastapi import WebSocketDisconnect
from google.genai.errors import APIError
import traceback
import json
import re
import time

load_dotenv()

# We need a global async client for the pro sidecar
pro_client = genai.Client()
# Reusable Live API client (v1alpha for Live sessions)
live_client = genai.Client(http_options={'api_version': 'v1alpha'})

SUPADATA_ENDPOINT = "https://api.supadata.ai/v1/transcript"

def extract_youtube_video_id(url: str) -> str | None:
    """Extract YouTube video ID from various URL formats."""
    import re
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([a-zA-Z0-9_-]{11})',
        r'youtube\.com/shorts/([a-zA-Z0-9_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

async def fetch_youtube_transcript(url: str) -> str:
    """Fetch YouTube transcript using Supadata API."""
    video_id = extract_youtube_video_id(url)
    if not video_id:
        return f"Could not extract video ID from: {url}"
    
    api_key = os.getenv("SUPADATA_API_KEY")
    if not api_key:
        print("[YouTube] No SUPADATA_API_KEY found, falling back to Gemini audio transcription")
        return await transcribe_with_gemini(url, video_id)
    
    clean_url = f"https://www.youtube.com/watch?v={video_id}"
    endpoint = f"{SUPADATA_ENDPOINT}?url={clean_url}&mode=native"
    
    try:
        async with aiohttp.ClientSession() as session:
            headers = {"x-api-key": api_key, "Content-Type": "application/json"}
            async with session.get(endpoint, headers=headers) as response:
                if response.status == 202:
                    # Async job - poll for completion
                    data = await response.json()
                    job_id = data.get("jobId")
                    if job_id:
                        print(f"[YouTube] Supadata AI generation started (JobID: {job_id}). Polling...")
                        for attempt in range(30):  # 60 seconds max
                            await asyncio.sleep(2)
                            poll_url = f"{SUPADATA_ENDPOINT}/{job_id}"
                            async with session.get(poll_url, headers=headers) as poll_res:
                                if poll_res.ok:
                                    poll_data = await poll_res.json()
                                    if poll_data.get("status") == "completed" and poll_data.get("content"):
                                        text = " ".join(seg.get("text", "") for seg in poll_data["content"])
                                        print(f"[YouTube] Transcript fetched ({len(text)} chars)")
                                        return text
                                    elif poll_data.get("status") == "failed":
                                        print(f"[YouTube] Supadata AI generation failed")
                                        break
                        print("[YouTube] Polling timed out, falling back to Gemini audio transcription")
                        return await transcribe_with_gemini(url, video_id)
                
                if not response.ok:
                    print(f"[YouTube] Supadata API error: {response.status}")
                    return await transcribe_with_gemini(url, video_id)
                
                data = await response.json()
                if not data.get("content"):
                    print("[YouTube] No transcript returned, falling back to Gemini audio transcription")
                    return await transcribe_with_gemini(url, video_id)
                
                text = " ".join(seg.get("text", "") for seg in data["content"])
                print(f"[YouTube] Transcript fetched ({len(text)} chars)")
                return text
    except Exception as e:
        print(f"[YouTube] Error fetching transcript: {e}")
        return await transcribe_with_gemini(url, video_id)


async def transcribe_with_gemini(url: str, video_id: str) -> str:
    """Transcribe a YouTube video using Gemini's native audio processing capability."""
    youtube_url = f"https://www.youtube.com/watch?v={video_id}"
    
    prompt = """Transcribe the audio from this YouTube video into a complete, detailed text transcript.
Include all spoken words. Output ONLY the transcript text, no timestamps or formatting."""
    
    print(f"[YouTube] Transcribing with Gemini: {youtube_url}")
    try:
        response = await asyncio.to_thread(
            pro_client.models.generate_content,
            model='gemini-2.5-flash',
            contents=[{
                "role": "user",
                "parts": [
                    {"file_data": {"file_uri": youtube_url, "mime_type": "audio/mpeg"}},
                    {"text": prompt}
                ]
            }]
        )
        text = response.text or ""
        print(f"[YouTube] Gemini transcription complete ({len(text)} chars)")
        return text
    except Exception as e:
        print(f"[YouTube] Gemini transcription failed: {e}")
        return f"[Could not transcribe YouTube video: {e}]"


async def fetch_website_content(url: str) -> str:
    """Scrapes the target URL and returns the text content, embedding markers for images."""
    try:
        from urllib.parse import urljoin
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                html = await response.text()
                soup = BeautifulSoup(html, "html.parser")
                
                # Replace images with descriptive text markers so the Planner AI sees them
                for img in soup.find_all('img'):
                    src = img.get('src')
                    alt = img.get('alt', '')
                    if src:
                        full_url = urljoin(url, src)
                        img.replace_with(f"\n[EMBEDDED IMAGE: URL='{full_url}' | ALT='{alt}']\n")

                # Remove scripts and styles
                for script in soup(["script", "style"]):
                    script.decompose()
                text = soup.get_text(separator='\n')
                # Collapse whitespace
                lines = (line.strip() for line in text.splitlines())
                chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
                text = '\n'.join(chunk for chunk in chunks if chunk)
                return text
    except Exception as e:
        print(f"[Scraper] Error fetching {url}: {e}")
        return f"Error fetching content: {e}"


async def fetch_website_content_grounded(url: str) -> str:
    """[Improvement E] Scrape a URL then use Gemini Flash + Google Search to produce
    a grounded, fact-enriched content digest. Falls back to raw scrape on error."""
    raw = await fetch_website_content(url)
    print(f"[Scraper] Creating grounded digest for: {url}")
    try:
        response = await asyncio.to_thread(
            pro_client.models.generate_content,
            model='gemini-2.5-flash',
            contents=(
                f"You are a research assistant. Summarize and fact-check the following web page content. "
                f"Use Google Search to supplement any information that seems incomplete, outdated, or missing. "
                f"Output a well-structured, comprehensive summary (aim for ~1500 words) suitable for use as "
                f"source material for an educational diagram.\n\nSource URL: {url}\n\nPage content:\n{raw[:20000]}"
            ),
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )
        )
        digest = response.text or raw
        print(f"[Scraper] Grounded digest ready ({len(digest)} chars) for: {url}")
        return digest
    except Exception as e:
        print(f"[Scraper] Grounded digest failed for {url}: {e} — using raw scrape")
        return raw


def is_youtube_url(url: str) -> bool:
    """Check if a URL is a YouTube video URL."""
    return bool(extract_youtube_video_id(url))


async def web_search_sources(query: str, depth: str = "fast") -> list[dict]:
    """Search the web and return a list of {title, url, snippet} source candidates.
    
    Uses Gemini + Google Search grounding to find authoritative sources.
    depth='fast' → quick summary; depth='deep' → richer research prompt.
    """
    print(f"[Search] query='{query}' depth={depth}")
    
    if depth == "deep":
        prompt = (
            f"You are a research librarian. Find the most authoritative, diverse, and relevant web sources about: {query}. "
            f"Include primary sources, academic papers, encyclopaedias, and reputable news outlets. "
            f"Write a brief 1-2 sentence overview of the topic."
        )
    else:
        prompt = (
            f"Find the most relevant and reliable web sources about: {query}. "
            f"Write a brief 1-sentence summary."
        )
    
    try:
        response = await asyncio.wait_for(
            asyncio.to_thread(
                pro_client.models.generate_content,
                model='gemini-2.5-flash',
                contents=prompt,
                config=types.GenerateContentConfig(
                    tools=[types.Tool(google_search=types.GoogleSearch())]
                )
            ),
            timeout=20.0
        )
        
        results: list[dict] = []
        seen_urls: set[str] = set()
        seen_titles: set[str] = set()
        
        gm = response.candidates[0].grounding_metadata if response.candidates else None
        if gm:
            # Build index→snippet map from grounding_supports
            support_snippets: dict[int, str] = {}
            for support in (getattr(gm, "grounding_supports", []) or []):
                segment = getattr(support, "segment", None)
                if segment:
                    text = (getattr(segment, "text", "") or "").replace("**", "").strip()
                    chunk_indices = getattr(support, "grounding_chunk_indices", []) or []
                    for idx in chunk_indices:
                        if idx not in support_snippets:  # keep first snippet for each index
                            support_snippets[idx] = text[:200]
            
            chunks = getattr(gm, "grounding_chunks", []) or []
            for i, chunk in enumerate(chunks):
                web = getattr(chunk, "web", None)
                if not web:
                    continue
                url = getattr(web, "uri", None) or ""
                title = getattr(web, "title", None) or url
                # Deduplicate by both redirect URL and domain title
                if not url or url in seen_urls or title in seen_titles:
                    continue
                seen_urls.add(url)
                seen_titles.add(title)
                snippet = support_snippets.get(i, "")
                results.append({"title": title, "url": url, "snippet": snippet})
        
        print(f"[Search] Returning {len(results)} result(s)")
        return results
    except Exception as e:
        print(f"[Search] Error: {e}")
        return []


async def gather_source_content(sources: list, send_status, use_deep_digest: bool = False) -> tuple[str, list[str]]:
    """
    Process all sources and return combined content + list of source labels.
    sources: [{ type: 'url'|'youtube'|'text'|'file', content: str, label: str }]
    use_deep_digest: if True, URL sources are processed via Gemini+Search grounded digest (Improvement E).
    """
    source_labels = []

    async def _fetch_one(i: int, source: dict) -> str:
        src_type = source.get("type", "text")
        content = source.get("content", "")
        label = source.get("label", f"Source {i+1}")

        if src_type == "url":
            if "vertexaisearch.cloud.google.com" in content:
                text = f"[Web Source: {label} - Detailed content requires browser access. AI must leverage internal knowledge or Google Search tool.]"
            elif use_deep_digest:
                text = await fetch_website_content_grounded(content)
            else:
                text = await fetch_website_content(content)
            return f"=== SOURCE: {label} (Web Page) ===\n{text}"
        elif src_type == "youtube":
            text = await fetch_youtube_transcript(content)
            return f"=== SOURCE: {label} (YouTube Video Transcript) ===\n{text}"
        elif src_type == "file":
            return f"=== SOURCE: {label} (Uploaded File) ===\n{content}"
        elif src_type == "text":
            return f"=== SOURCE: User Text Input ===\n{content}"
        else:
            return f"=== SOURCE: {label} ===\n{content}"

    for i, source in enumerate(sources):
        source_labels.append(source.get("label", f"Source {i+1}"))

    await send_status(f"Reading {len(sources)} source(s)...")
    combined_parts = await asyncio.gather(*[_fetch_one(i, s) for i, s in enumerate(sources)])

    combined_content = "\n\n".join(combined_parts)
    return combined_content, source_labels


def should_use_web_search(sources: list) -> bool:
    """Determine if web search grounding should be used.
    
    Triggers for:
    - A single short text input (<100 words) — original behaviour
    - A single URL or YouTube source — scraped content may be stale/incomplete
    - Up to 2 sources where at least one is a URL/YouTube
    """
    if len(sources) > 2:
        return False
    for source in sources:
        src_type = source.get("type", "")
        if src_type in ("url", "youtube"):
            return True
        if src_type == "text" and len(source.get("content", "").split()) < 100:
            return True
    return False


async def generate_presentation_plan(combined_content: str, source_labels: list, use_web_search: bool = False) -> tuple[str, list[dict]]:
    """Uses Gemini to digest the sources and output an Interactive Graphic.
    
    Returns:
        (response_text, grounding_sources) where grounding_sources is a list of
        {"title": str, "url": str} dicts from Google Search grounding metadata.
    """
    sources_summary = ", ".join(source_labels) if source_labels else "provided content"
    prompt = f"""
    #Role: Children's Education SVG Animation Engineer
    ##Profile
    -**Author**: antigravity
    -**Version**: 2.0 (HTML/SVG Edition)
    -**Description**: You are an expert in education, specializing in transforming complex knowledge into intuitive, interesting, flat cartoon SVG animations with HTML UI controls.
    
    CRITICAL RULE: ALL TEXT IN THE SVG AND UI MUST BE IN ENGLISH.
    
    ### CRITICAL STEP 1: CONTENT SYNTHESIS
    You will be provided with content from the following source(s): {sources_summary}.
    Before drawing anything, you MUST analyze the text and isolate **ONE SINGLE CORE CONCEPT, MECHANISM, OR STORY** to visualize.
    - DO NOT try to cram all the content into one diagram.
    - Pick the *most visually interesting* or *most fundamental* concept (e.g., if the text is about the Nobel Prize for Circadian Rhythms, just draw the TTFL feedback loop, nothing else).
    - Simplify, simplify, simplify. Your target audience is a middle-school student.
    
    ### CRITICAL STEP 2: DESIGN THE INTERACTIVE WIDGET
    Design a single, highly engaging, interactive HTML/SVG Widget that visually encapsulates ONLY the core concept you selected.
    
    You must output FIVE things:
    1. A raw HTML snippet containing JUST the SVG and its immediate wrappers wrapped in `<svg-panel>...</svg-panel>` tags.
    2. A raw HTML snippet containing JUST the UI controls/dashboard wrapped in `<controls-panel>...</controls-panel>` tags.
    3. A concise 1-paragraph summary wrapped in `<narration>...</narration>` tags that explains exactly what is drawn in the diagram and how the user should be guided through it. This will be given to a blind Voice Assistant.
    4. A short, highly engaging title for the topic wrapped in `<nblm-title>...</nblm-title>` tags.
    5. A short subtitle instructing the user how to interact with the graphic. It MUST mention that the interactive controls are on the right panel. Wrap in `<nblm-subtitle>...</nblm-subtitle>` tags. Example: "Use the controls on the right to explore the concept."
    
    CRITICAL RULES FOR THE INTERACTIVE GRAPHIC:
    1. ELEMENT IDS: ALL major visual elements in your SVG MUST have descriptive `id` attributes (e.g., `id="sun"`, `id="earth"`, `id="orbit-path"`). This allows the voice assistant to highlight and modify specific elements when the user asks. Group related elements in `<g id="...">` tags.
    2. SCIENTIFIC & PHYSICAL ACCURACY: Your diagrams must be strictly logically, geometrically, and physically correct!
       - If drawing astronomical/physical shadows (like the Earth's terminator), remember that the shadow is cast from an external light source. Only rotate the physical object, NOT the shadow.
       - If drawing mechanical gears or chemical bonds, the sizes, ratios, and angles must be mathematically plausible. Do not place elements haphazardly.
    3. VISUAL STYLE: You MUST use a **world-class, premium, modern UI aesthetic**! It must look professionally designed.
       - Use a sophisticated, modern color palette: Slate grays for text (#0f172a, #334155), crisp white or very soft slate (#f8fafc) backgrounds, and a single elegant primary accent color (e.g., Royal Blue #2563eb or Emerald #059669).
       - Typography is critical: Use standard sans-serif system fonts (e.g. system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto) with proper hierarchy.
       - Use **generous whitespace/padding** everywhere.
       - The SVG vectors themselves should be elegantly simple, thick, perfectly symmetric, and use soft refined gradients or solid clean colors. Limit the number of visual elements to 5-10 maximum.
    4. FORMAT & SEPARATION: DO NOT output an outer flexbox wrapper. We are injecting your `<svg-panel>` and `<controls-panel>` blocks directly into our own layout. The `<svg-panel>` should contain your visual SVG. The `<controls-panel>` should contain your HTML controls. Each should use width/height `100%`. DO NOT ADD white backgrounds, borders, or box-shadows to these core containers, as our parent React cards handle the styling.
    5. ADVANCED INTERACTIVITY & STATE: You must generate deeply interactive graphics, not just static diagrams with click-to-highlight buttons.
       - Use vanilla Javascript to maintain dynamic state (e.g., current step, slider values, play/pause timers).
       - Create controls like `<input type="range">` (sliders), standard buttons, or Play/Pause toggles in the `<controls-panel>`.
       - Write bespoke Javascript functions that directly mutate the SVG DOM elements (e.g., changing `transform="rotate(...)"`, `x`, `y`, `fill`, `opacity`, `stroke-dashoffset`, or text content) based on the user's input.
       - Always include an info-panel that updates its title and description dynamically based on the current state.
       - CRITICAL SYNTAX WARNING: You MUST use backticks (` `) for ALL strings in your Javascript (e.g., `The Earth's axis`). NEVER use single quotes (') or double quotes ("). Single quotes will cause a fatal syntax error when your text contains apostrophes (like "Earth's").
       - Send telemetry using `if (window.sendEventToAI) {{ window.sendEventToAI(`User changed state to ${{value}}`); }}`.
       
       EXAMPLE ADVANCED PATTERN (Adapt this to your specific concept):
       ```
       <div id="controls-panel">
         <h2>System Control</h2>
         <input type="range" id="timeSlider" min="0" max="100" step="any" value="0" oninput="updateState(this.value)">
         <button id="playBtn" class="ctrl-btn" onclick="togglePlay()">▶ Auto-Play</button>
         <div id="info-panel" style="margin-top:16px; padding:16px; background:#f8fafc; border-radius:12px; border:1px solid #e2e8f0;">
           <div id="info-title" style="font-weight:600; font-size:15px; color:#0f172a; margin-bottom:6px;">Phase 0</div>
           <div id="info-desc" style="font-size:13px; color:#475569; line-height:1.5;">Drag the slider to begin.</div>
         </div>
       </div>

       <script>
       let isPlaying = false;
       let playInterval;
       
       function updateState(val) {{
         // 1. Mutate SVG visually (bespoke math/logic based on the concept)
         document.getElementById('planet-orbit').setAttribute('transform', `rotate(${{val * 3.6}} 400 250)`);
         
         // 2. Update Info Panel
         document.getElementById('info-title').textContent = `Phase ${{Math.floor(val/25)}}`;
         document.getElementById('info-desc').textContent = `At ${{val}}%, the system is transitioning...`;
         
         if (window.sendEventToAI && val % 25 === 0) {{ 
           window.sendEventToAI(`User moved graphic to phase ${{val}}`); 
         }}
       }}
       
       function togglePlay() {{
         isPlaying = !isPlaying;
         let btn = document.getElementById('playBtn');
         if (isPlaying) {{
           if (btn) btn.innerHTML = "⏸ Pause Auto-Play";
           playInterval = setInterval(() => {{
             let slider = document.getElementById('timeSlider');
             let nextVal = (Number(slider.value) + 1) % 101;  // Loop back to 0 after 100
             if (nextVal > 100) nextVal = 0;
             slider.value = nextVal;
             updateState(nextVal);
           }}, 50);
         }} else {{
           if (btn) btn.innerHTML = "▶ Auto-Play";
           clearInterval(playInterval);
         }}
       }}
       </script>
       ```
       
       CRITICAL AUTO-PLAY DEBUGGING CHECKLIST:
       - ALWAYS declare `let isPlaying = false;` and `let playInterval;` at the top of your script
       - ALWAYS use `clearInterval(playInterval)` before starting a new interval to prevent multiple intervals stacking
       - ALWAYS update button text immediately when toggling: "▶ Auto-Play" when paused, "⏸ Pause" when playing
       - ALWAYS ensure your slider has proper min/max attributes and your loop respects them
       - TEST your modulo arithmetic: if max is 100, use `(val + 1) % 101` not `% 100`
       - ALWAYS set `step="any"` on range inputs used for animation. The default step="1" causes fractional increments like +0.4 to be silently rounded back to the previous integer, breaking the animation loop.

       CRITICAL: You are NOT limited to highlight colors. Build physical interactivity tailored to the concept—sliders that orbit, buttons that pump data flows, switches that change day/night, etc. You must still include `<g id="node-XXX">` and use `transform-box: fill-box;` for any nodes you animate via CSS.

    4. ANIMATION: The SVG must have animated elements. Use CSS @keyframes for idle animations (pulsing, rotating, dashed line flow). All node groups need `transition: all 0.3s ease` for smooth highlight effects.
    5. NO BORDER RADIUS ON SVG: Keep `<svg>` elements square/rectangular. Do not use `border-radius` on `<svg>`.
    6. ANIMATION STATE TEXT & INTERVAL MANAGEMENT: If you add play/pause buttons:
       - The button text MUST ALWAYS show the action that will happen when clicked. If paused: "▶ Auto-Play". If playing: "⏸ Pause".
       - ALWAYS call `clearInterval(playInterval)` before starting a new interval to prevent multiple intervals stacking
       - ALWAYS declare interval variables at the top of your script scope: `let playInterval;`
       - The frontend relies on button text changes to track play state
    7. TEXT WRAPPING: SVG text elements do not auto-wrap. Use foreignObject with explicit width/height for any text longer than 3 words. Inner div must use `overflow:hidden; word-wrap:break-word; box-sizing:border-box; padding:4px;`.
    8. NARRATION: Write a concise 1-paragraph summary in `<narration>...</narration>` tags describing the diagram for a voice assistant.
    9. SVG CLEANLINESS: The svg-panel must contain ONLY the visual diagram — NO paragraphs of text. Short labels (1-3 words) are OK. All explanations go in controls-panel.
    10. LABEL READABILITY: Place text labels LAST in SVG markup (painter's model). Add a semi-transparent white rect behind each label. Use font-weight bold and 14px+ size.

    Source Content:
    {combined_content[:40000]}
    """
    
    print("[Planner] Generating presentation plan using Gemini 3.1 Pro Preview...")
    grounding_sources: list[dict] = []
    try:
        # Build generation config
        gen_kwargs = {
            "model": 'gemini-3.1-pro-preview',
            "contents": prompt,
        }
        
        # Add web search grounding (Improvement A: trigger for URL/YouTube too)
        if use_web_search:
            print("[Planner] Using Google Search grounding for source content enrichment")
            gen_kwargs["config"] = types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )
        
        response = await asyncio.to_thread(
            pro_client.models.generate_content,
            **gen_kwargs
        )
        print(f"[Planner] Plan generated successfully. Raw Output Length: {len(response.text)}\n")

        # Improvement C: extract grounding citations from response metadata
        if use_web_search:
            try:
                gm = response.candidates[0].grounding_metadata if response.candidates else None
                if gm:
                    search_queries = list(getattr(gm, "web_search_queries", []) or [])
                    for chunk in (getattr(gm, "grounding_chunks", []) or []):
                        web = getattr(chunk, "web", None)
                        if web:
                            uri = getattr(web, "uri", None)
                            title = getattr(web, "title", None) or uri
                            if uri and not any(s["url"] == uri for s in grounding_sources):
                                grounding_sources.append({"title": title, "url": uri})
                    print(f"[Grounding] {len(grounding_sources)} citation(s) extracted. Queries: {search_queries}")
            except Exception as meta_err:
                print(f"[Grounding] Could not extract metadata: {meta_err}")

        return response.text, grounding_sources
    except Exception as e:
        print(f"[Planner] Error: {e}")
        return "", []

async def handle_live_session(websocket: WebSocket, sources: list, research_mode: str = "fast"):
    """
    Manages the realtime WebSocket connection bridging the frontend and Gemini Live API.
    research_mode: 'off' = no web search; 'fast' = grounding on generation only;
                   'deep' = grounded URL digest + generation grounding.
    """
    
    # Helper to send status updates
    async def send_status(message: str):
        try:
            await websocket.send_json({"type": "status", "message": message})
        except:
            pass
    
    try:
        # Map research_mode to feature flags
        use_deep_digest = (research_mode == "deep")   # Improvement E: Gemini+Search URL pre-processing
        use_search = (research_mode != "off") and should_use_web_search(sources)  # Improvement A: gen-time grounding
        
        print(f"[Session] research_mode={research_mode} | use_deep_digest={use_deep_digest} | use_search={use_search}")
        
        # 1. Phase 1: Source Gathering & Planning
        await send_status("Analyzing sources...")
        await websocket.send_json({"type": "phase", "phase": "analyzing"})
        
        combined_content, source_labels = await gather_source_content(sources, send_status, use_deep_digest=use_deep_digest)
        
        await send_status("Designing interactive animated graphic...")
        await websocket.send_json({"type": "phase", "phase": "designing"})
        
        # Start a background task to keep the websocket alive periodically (avoiding Vite proxy 1006 drop)
        keep_alive_task = None
        async def keep_alive():
            try:
                dots = 1
                while True:
                    await asyncio.sleep(15)
                    await websocket.send_json({"type": "status", "message": f"Designing interactive animated graphic{'.' * dots}"})
                    dots = (dots % 3) + 1
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        try:
            keep_alive_task = asyncio.create_task(keep_alive())
            interactive_graphic_plan_raw, grounding_sources = await generate_presentation_plan(combined_content, source_labels, use_search)
        finally:
            if keep_alive_task:
                keep_alive_task.cancel()
        
        # Extract the SVG and Controls from the raw text safely
        svg_html = ""
        controls_html = ""
        
        match_svg_panel = re.search(r'<svg-panel>(.*?)</svg-panel>', interactive_graphic_plan_raw, re.DOTALL | re.IGNORECASE)
        if match_svg_panel:
            svg_html = match_svg_panel.group(1).strip()
        else:
            # fallback
            match_svg = re.search(r'(<svg.*?</svg>)', interactive_graphic_plan_raw, re.DOTALL | re.IGNORECASE)
            if match_svg:
                svg_html = match_svg.group(1)

        match_controls_panel = re.search(r'<controls-panel>(.*?)</controls-panel>', interactive_graphic_plan_raw, re.DOTALL | re.IGNORECASE)
        if match_controls_panel:
            controls_html = match_controls_panel.group(1).strip()
        else:
            # fallback
            controls_html = "<div style='padding: 24px;'>No controls generated.</div>"

            
        # FORCE CLEAN: Remove literal backslash escapes for quotes, backticks, and dollar signs just in case the model hallucinates them
        svg_html = svg_html.replace('\\"', '"').replace("\\'", "'").replace('\\`', '`').replace('\\$', '$')
        controls_html = controls_html.replace('\\"', '"').replace("\\'", "'").replace('\\`', '`').replace('\\$', '$')
        
        # Extract Narration
        narration_context = "No specific narration context provided."
        match_narration = re.search(r'<narration>(.*?)</narration>', interactive_graphic_plan_raw, re.DOTALL | re.IGNORECASE)
        if match_narration:
            narration_context = match_narration.group(1).strip()
        
        # Extract Title and Subtitle
        title = "Interactive Presentation"
        match_title = re.search(r'<nblm-title>(.*?)</nblm-title>', interactive_graphic_plan_raw, re.DOTALL | re.IGNORECASE)
        if match_title:
            title = match_title.group(1).strip()
            
        subtitle = "Explore the concepts using the controls on the right."
        match_subtitle = re.search(r'<nblm-subtitle>(.*?)</nblm-subtitle>', interactive_graphic_plan_raw, re.DOTALL | re.IGNORECASE)
        if match_subtitle:
            subtitle = match_subtitle.group(1).strip()
        
        import os
        import datetime
        import re as regex_fallback
        
        os.makedirs("generated_graphics", exist_ok=True)
        safe_title = regex_fallback.sub(r'[^a-zA-Z0-9_\-]', '_', title).strip('_').lower()
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"generated_graphics/{safe_title}_{timestamp}.html"
        
        # Build source URL reference for saved file
        source_urls = [s.get("content", "")[:200] for s in sources if s.get("type") in ("url", "youtube")]
        source_ref_html = ""
        for surl in source_urls:
            source_ref_html += f'<p style="font-size: 13px; margin-top: -8px;"><a href="{surl}" target="_blank" style="color: #2563eb; text-decoration: none;">View Original Source ↗</a></p>'
        
        with open(filename, "w") as f:
            # Wrap the SVG and Controls in a basic HTML structure so it's viewable independently
            full_html = f"""<!DOCTYPE html>
<html>
<head>
    <title>{title}</title>
    <style>
        body {{ font-family: sans-serif; display: flex; gap: 24px; padding: 24px; background: #f0f4f9; height: 100vh; margin: 0; box-sizing: border-box; }}
        .svg-container {{ flex: 1; background: white; border-radius: 24px; padding: 32px; display: flex; justify-content: center; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }}
        .controls-container {{ width: 380px; background: white; border-radius: 24px; padding: 32px; overflow-y: auto; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }}
    </style>
</head>
<body>
    <div class="svg-container">
        {svg_html}
    </div>
    <div class="controls-container">
        <h2>{title}</h2>
        <p style="color: #64748b;">{subtitle}</p>
        {source_ref_html}
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
        {controls_html}
    </div>
</body>
</html>"""
            f.write(full_html)
            
        # Also remove stale debug copy
        try:
            os.remove("debug_svg.xml")
        except FileNotFoundError:
            pass
            
        # Pre-compute controls inventory so reconnects don't need to re-parse HTML
        controls_inventory = _extract_controls_inventory(svg_html, controls_html)

        # Send the SVG and Controls directly to the frontend
        await websocket.send_json({
            "type": "interactive_svg",
            "svg_html": svg_html,
            "controls_html": controls_html,
            "title": title,
            "subtitle": subtitle,
            "narration_context": narration_context,
            "source_labels": source_labels,
            "grounding_sources": grounding_sources,  # Improvement C: citation URLs for the UI
            "controls_inventory": controls_inventory,
        })

        # Signal graphic is complete
        await websocket.send_json({"type": "phase", "phase": "complete"})

        # 2. Phase 2: Live Presenter — loop to support multiple start/end cycles
        # Improvement D: pass grounding context into live session so AI can reference sources
        while True:
            ws_alive = await _run_live_session(websocket, narration_context, source_labels, svg_html, controls_html, grounding_sources, controls_inventory)
            if not ws_alive:
                break  # Client disconnected — stop looping

    except Exception as e:
        print(f"[Session] UNHANDLED EXCEPTION in handle_live_session: {type(e).__name__}: {e}")
        traceback.print_exc()
        try:
            await websocket.send_json({"type": "error", "message": f"Generation failed: {type(e).__name__}: {e}"})
            await websocket.close()
        except Exception:
            pass



async def handle_live_restart(websocket: WebSocket, narration_context: str, source_labels: list[str], svg_html: str, controls_html: str = "", controls_inventory: str = ""):
    """
    Restart a live conversation on an existing graphic.
    Skips graphic generation and goes straight to the Live API.
    """
    print(f"[Live Restart] Starting with {len(source_labels)} source label(s)")
    while True:
        ws_alive = await _run_live_session(websocket, narration_context, source_labels, svg_html, controls_html, controls_inventory=controls_inventory, eager_connect=True)
        if not ws_alive:
            break


def _extract_controls_inventory(svg_html: str, controls_html: str = "") -> str:
    """Extract a text inventory of interactive controls from the generated HTML."""
    full_html = svg_html + "\n" + controls_html
    if not full_html.strip():
        return "No controls information available."
    try:
        soup = BeautifulSoup(full_html, "html.parser")
        
        # Try to find a specific controls panel first, then fall back to entire HTML
        search_root = (
            soup.find(id="controls-panel")
            or soup.find("div", class_="controls-container")
            or soup.find("div", class_="controls-area")
            or soup.find("div", class_="controls")
        )
        
        # If no specific panel found, parse just the controls_html if available
        if not search_root and controls_html.strip():
            controls_soup = BeautifulSoup(controls_html, "html.parser")
            search_root = controls_soup  # Use entire controls HTML as search root
        
        # Last resort: search the entire document
        if not search_root:
            search_root = soup
        
        items = []
        # Find buttons — detect toggle/play-pause buttons
        for btn in search_root.find_all("button"):
            text = btn.get_text(strip=True)
            btn_id = btn.get("id", "")
            if text:
                onclick = btn.get("onclick", "")
                text_lower = text.lower()
                id_str = f' (id: "{btn_id}")' if btn_id else ""
                # Detect toggle/play-pause buttons
                is_toggle = any(kw in onclick.lower() for kw in ["toggleplay", "toggle", "isplaying", "autoplay", "auto_play", "toggleflight", "toggleanim"])
                has_play_text = any(kw in text_lower for kw in ["play", "start", "auto", "▶", "resume", "begin", "launch"])
                has_pause_text = any(kw in text_lower for kw in ["pause", "stop", "⏸", "halt", "‖"])
                if is_toggle or has_play_text or has_pause_text:
                    items.append(f'- Button{id_str} (toggle): "{text}" — toggles play/pause. The label shows what the NEXT action will be (opposite of current state).')
                else:
                    items.append(f'- Button{id_str}: "{text}"')
        # Find sliders/range inputs
        for inp in search_root.find_all("input"):
            inp_type = inp.get("type", "text")
            inp_id = inp.get("id", "")
            id_str = f' (id: "{inp_id}")' if inp_id else ""
            # Build a descriptive label from multiple sources
            label = inp.get("aria-label") or inp.get("title") or ""
            if not label:
                # Check for a nearby label element
                if inp_id:
                    label_el = search_root.find("label", attrs={"for": inp_id})
                    if label_el:
                        label = label_el.get_text(strip=True)
            if not label:
                # Check preceding sibling text or parent text
                parent = inp.parent
                if parent:
                    parent_text = parent.get_text(strip=True)
                    # Remove the input's own value from parent text
                    inp_val = inp.get("value", "")
                    clean_text = parent_text.replace(inp_val, "").strip()[:60]
                    if clean_text:
                        label = clean_text
            if not label:
                label = inp.get("id") or inp_type
            
            if inp_type == "range":
                min_val = inp.get("min", "?")
                max_val = inp.get("max", "?")
                cur_val = inp.get("value", "?")
                items.append(f'- Slider{id_str}: "{label}" (range: {min_val}–{max_val}, current: {cur_val}). NOTE: You cannot drag sliders directly — tell the user to adjust it manually.')
            else:
                items.append(f'- Input ({inp_type}){id_str}: "{label}"')
        # Find select dropdowns
        for sel in search_root.find_all("select"):
            label = sel.get("aria-label") or sel.get("id") or "dropdown"
            options = [opt.get_text(strip=True) for opt in sel.find_all("option")]
            items.append(f'- Dropdown: "{label}" with options: {", ".join(options)}')
        # Find clickable divs/spans with onclick
        for el in search_root.find_all(attrs={"onclick": True}):
            text = el.get_text(strip=True)[:60]
            if text and not el.name == "button":
                items.append(f'- Clickable: "{text}"')
        
        if not items:
            # Fallback: just get visible text blocks
            text_content = search_root.get_text(separator="\n", strip=True)
            return f"Controls panel text content:\n{text_content[:500]}"
        
        result = "\n".join(items)
        print(f"[Controls Inventory] Detected {len(items)} control(s):\n{result}")
        return result
    except Exception as e:
        return f"Could not parse controls: {e}"


async def _run_live_session(websocket: WebSocket, narration_context: str, source_labels: list[str], svg_html: str, controls_html: str = "", grounding_sources: list[dict] | None = None, controls_inventory: str = "", eager_connect: bool = False):
    """
    Shared Live API session logic. Handles system instruction, tool declarations,
    Gemini connection, and bidirectional audio/tool streaming.
    """
    # Build source description for system instruction
    source_desc = ", ".join(source_labels) if source_labels else "the provided content"

    # Improvement D: build grounding context block from generation-time citations
    grounding_context_block = ""
    if grounding_sources:
        source_lines = "\n".join(
            f"  - {s.get('title', s.get('url', ''))} ({s.get('url', '')})"
            for s in grounding_sources[:10]
        )
        grounding_context_block = f"""

    <grounding_context>
    This diagram was grounded using Google Search during generation. You may reference these sources by name when speaking:
{source_lines}
    When relevant, naturally cite these sources (e.g. "According to Wikipedia...", "As reported by NASA..."). Do NOT re-fetch these with fetch_more_detail — the content is already in the diagram.
    </grounding_context>"""
    
    # Cache controls inventory once at session start — reused for every click_element tool response
    cached_controls_inv = controls_inventory or _extract_controls_inventory(svg_html, controls_html)

    system_instruction = f"""\
    ALWAYS respond in English only. Never switch languages.

    You are Narluga, an Interactive Guide for an animated SVG diagram about: {source_desc}.
    Voice is your primary medium. Be concise, conversational, and engaging.

    <diagram_context>
    {narration_context}
    </diagram_context>{grounding_context_block}

    <available_controls>
    {cached_controls_inv}
    </available_controls>

    CORE RULES:
    1. VOICE-FIRST: Your first response must be spoken words only — no tool calls. Greet briefly, then silently click auto-play (if available) using its exact ID (e.g. 'playBtn'). Never announce starting auto-play.
    2. TOOLS: Use highlight_element to point things out, click_element for buttons, navigate_to_section to move between areas, modify_element to change visuals (scale/fill/opacity/display/filter). Call one tool at a time. Always speak after tool calls.
    3. BUTTONS: Only reference controls that exist in <available_controls>. Use exact IDs for click_element. highlight_element does NOT click — only click_element clicks.
    4. TOGGLE BUTTONS: "▶ Auto-Play" = animation is PAUSED. "⏸ Pause" = animation is PLAYING. The label shows the NEXT action.
    5. SLIDERS: Cannot be dragged programmatically — tell user to adjust manually.
    6. ANIMATION: Auto-play loops continuously until explicitly paused. Never assume it stopped.
    7. USER INTERACTIONS: When you receive "[System Status: ... Action: ...]", the user clicked something. IMMEDIATELY acknowledge their action briefly. Don't continue previous narration.
    8. CURSOR: When you receive "[Cursor position: ...]", briefly acknowledge what they're pointing at. Don't repeat for same element.
    9. If user asks about something not in diagram, use fetch_more_detail.
    10. If user asks to change visuals, use modify_element.
    """
    
    # Define agentic tools for the Live API session
    agent_tools = [
        types.Tool(function_declarations=[
            types.FunctionDeclaration(
                name="highlight_element",
                description="Visually highlight/pulse a specific element in the interactive SVG diagram to draw the user's attention. Use this whenever you're explaining a specific part of the diagram. The element will glow for a few seconds.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        element_id=types.Schema(
                            type="STRING",
                            description="A keyword or identifier for the element to highlight. This should match text content, labels, or section IDs visible in the diagram. Examples: 'mitochondria', 'step-3', 'feedback-loop', 'input', 'output'."
                        ),
                        color=types.Schema(
                            type="STRING",
                            description="The glow color as a hex code. Use blue '#3b82f6' for informational, green '#10b981' for positive, amber '#f59e0b' for caution, red '#ef4444' for critical. Default: '#3b82f6'."
                        )
                    ),
                    required=["element_id"]
                )
            ),
            types.FunctionDeclaration(
                name="navigate_to_section",
                description="Scroll/pan the diagram viewport to focus on a specific section. Use when transitioning between different parts of the explanation.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        section=types.Schema(
                            type="STRING",
                            description="The section to navigate to. Match keywords from the diagram labels or conceptual areas, e.g., 'introduction', 'step-1', 'conclusion', 'feedback-loop'."
                        )
                    ),
                    required=["section"]
                )
            ),
            types.FunctionDeclaration(
                name="zoom_view",
                description="Zoom in or out on the diagram. Use zoom_in when showing details, zoom_out when returning to overview.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        direction=types.Schema(
                            type="STRING",
                            description="Either 'in' to zoom closer or 'out' to zoom back. Use 'reset' to return to default zoom."
                        )
                    ),
                    required=["direction"]
                )
            ),
            types.FunctionDeclaration(
                name="fetch_more_detail",
                description="Fetch additional information about a topic from the web using Google Search. Use when the user asks about something beyond what's covered in the diagram and you need more context to answer accurately.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        query=types.Schema(
                            type="STRING",
                            description="The search query to look up for more information."
                        )
                    ),
                    required=["query"]
                )
            ),
            types.FunctionDeclaration(
                name="modify_element",
                description="Modify the visual appearance of an element in the SVG diagram in real-time. Use this when the user asks you to change something about the graphic (e.g., 'make the sun bigger', 'change the ocean to green', 'hide the clouds').",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        element_id=types.Schema(
                            type="STRING",
                            description="A human-readable keyword matching a visible label or name in the diagram. Examples: 'probe', 'sun', 'electron', 'barrier', 'accretion disk'. Do NOT use CSS selectors, hex colors, or technical syntax like '#fff circle'. Just use a simple descriptive word."
                        ),
                        css_property=types.Schema(
                            type="STRING",
                            description="The CSS property name to change. Use one of: 'scale' (to resize), 'fill' (to recolor), 'opacity' (for transparency), 'display' (to show/hide), 'stroke' (border color), 'stroke-width' (border thickness), 'filter' (for visual effects)."
                        ),
                        value=types.Schema(
                            type="STRING",
                            description="The value for the CSS property. Examples: for scale use '2' (doubles size) or '0.5' (halves size). For fill use '#ef4444'. For opacity use '0.5'. For display use 'none' to hide. For filter use 'blur(3px)' or 'drop-shadow(0 0 10px gold)'."
                        )
                    ),
                    required=["element_id", "css_property", "value"]
                )
            ),
            types.FunctionDeclaration(
                name="click_element",
                description="Programmatically click a button or interactive element in the diagram or its controls panel. Use this to trigger any button interaction — including proactively starting auto-play at session start, or when the user requests it (e.g., 'stop the autoplay', 'click Play', 'toggle the switch'). This is the ONLY way to actually activate a button; highlight_element does NOT click anything.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        element_id=types.Schema(
                            type="STRING",
                            description="The precise ID of the button (e.g., 'playBtn') if one was provided in the <available_controls> list. If no ID is available, fall back to a keyword matching the exact text shown on the button."
                        )
                    ),
                    required=["element_id"]
                )
            ),
        ])
    ]
    
    # Reuse the module-level v1alpha client for Live API
    client = live_client
    # Use the specific audio-preview model
    model = "gemini-2.5-flash-native-audio-preview-12-2025"
    
    # Session resumption state
    resumption_handle = None
    
    def _build_config(handle=None):
        """Build LiveConnectConfig with optional resumption handle."""
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=types.Content(parts=[types.Part.from_text(text=system_instruction)]),
            tools=agent_tools,
            # --- STABILITY FEATURES ---
            # Context window compression: prevents context overflow from hover/interaction events
            context_window_compression=types.ContextWindowCompressionConfig(
                sliding_window=types.SlidingWindow(),
                trigger_tokens=25000  # Compress at moderate threshold to keep context lean
            ),
            # Session resumption: enables auto-reconnect with conversation state preserved
            session_resumption=types.SessionResumptionConfig(
                handle=handle  # None for new sessions, token string for resuming
            ),
        )
    
    config = _build_config()
    
    # WebSocket collision lock to prevent Starlette RuntimeError
    ws_lock = asyncio.Lock()
    
    # Shared mutable state for the session & reconnection signaling
    session_holder = {"session": None, "alive": True}
    go_away_event = asyncio.Event()  # Set when server sends GoAway
    client_disconnected = asyncio.Event()  # Set when frontend WS closes
    audio_started = asyncio.Event()  # Set when first mic audio frame arrives

    # Eager-connect buffering: buffer Gemini responses until user clicks Start
    eager_buffer = []              # Queued messages (audio, tool_action, clear) before user clicks
    eager_flushed = asyncio.Event()
    if not eager_connect:
        eager_flushed.set()        # Non-eager: no buffering, send directly from the start

    # --------------------------------------------------------------------------------
    # Wait for user to click "Start", THEN connect to Gemini Live API.
    # Returns True if session ended cleanly (WS still alive, can start another),
    # or False if client disconnected (WS closed, should stop).
    # --------------------------------------------------------------------------------
    MAX_RECONNECT_ATTEMPTS = 3
    reconnect_count = 0
    is_first_connection = True

    if not eager_connect:
        # Normal path: wait for user to click "Start Live Conversation" first
        print("[WebSocket] Waiting for user to start presentation...")
        try:
            while True:
                data = await websocket.receive_text()
                payload = json.loads(data)
                if payload.get("type") == "start_live_session":
                    break
        except WebSocketDisconnect:
            print("[WebSocket] Client disconnected before starting session.")
            return False
        except Exception as e:
            print(f"[WebSocket] Error while waiting to start: {e}")
            return False

        t0 = time.time()
        session_holder["t0"] = t0
        print(f"[TIMING] T+0.000s: start_live_session received")

        # Immediately signal conversation phase so frontend transitions instantly
        await websocket.send_json({"type": "phase", "phase": "conversation"})
        print(f"[TIMING] T+{time.time()-t0:.3f}s: phase:conversation sent")
        print("[WebSocket] User clicked Start — connecting to Gemini Live API...")
    else:
        # Set t0 for timing logs during pre-connect; will be reset when user actually clicks
        t0 = time.time()
        session_holder["t0"] = t0
        print("[Eager] Connecting to Gemini BEFORE user clicks Start...")

    while session_holder["alive"] and not client_disconnected.is_set():
        # Build config (with resumption handle for reconnections)
        if not is_first_connection and resumption_handle:
            config = _build_config(handle=resumption_handle)
            print(f"[Gemini] Reconnecting with resumption handle...")
        elif not is_first_connection:
            print("[Gemini] No resumption handle available, cannot reconnect.")
            break

        try:
            print(f"[TIMING] T+{time.time()-t0:.3f}s: connecting to Gemini Live API...")
            async with client.aio.live.connect(model=model, config=config) as session:
                session_holder["session"] = session
                go_away_event.clear()
                reconnect_count = 0  # Reset on successful connection

                if is_first_connection:
                    is_first_connection = False

                    if eager_connect:
                        # Eager path: send initial prompt NOW and start buffering Gemini responses.
                        # The receive_from_client task will handle start_live_session and flush.
                        print("[Eager] Gemini pre-connected. Sending initial prompt eagerly...")
                        session_holder["prompted"] = True
                        try:
                            await session.send_client_content(
                                turns=[types.Content(parts=[types.Part.from_text(
                                    text="The user just joined the session. Begin your welcome and overview now. Start speaking IMMEDIATELY — do NOT use any tools (highlight, click, etc.) until AFTER you have finished your initial welcome greeting. Get your voice to the user as fast as possible. After greeting, silently start auto-play (if available) without mentioning it — just click the button and begin narrating the content."
                                )])]
                            )
                            print("[Eager] Initial prompt sent to Gemini (pre-click)")
                        except Exception as e:
                            print(f"[Eager] Error sending eager initial prompt: {e}")
                        # Fall through — tasks will start, Gemini responses buffered until user clicks
                    else:
                        print(f"[TIMING] T+{time.time()-t0:.3f}s: Gemini connected")

                    # Send ready to confirm Gemini is connected (eager path defers this to flush)
                    if not eager_connect:
                        async with ws_lock:
                            await websocket.send_json({"type": "ready"})
                        print(f"[TIMING] T+{time.time()-t0:.3f}s: ready sent to frontend")
                else:
                    print("[Gemini] Session resumed successfully — conversation continues seamlessly.")

                # ------------------------------------------------------------------
                # CLIENT → GEMINI relay
                # ------------------------------------------------------------------
                async def receive_from_client_and_send_to_gemini():
                    try:
                        while session_holder["alive"]:
                            data = await websocket.receive_text()
                            payload = json.loads(data)

                            cur_session = session_holder["session"]
                            if cur_session is None:
                                continue  # Reconnecting, skip

                            if "realtimeInput" in payload:
                                if not audio_started.is_set():
                                    audio_started.set()
                                    print("[Receive Task] First audio frame received from client")
                                chunk = payload["realtimeInput"]["mediaChunks"][0]
                                b64_data = chunk["data"]
                                mime_type = chunk["mimeType"]
                                raw_bytes = base64.b64decode(b64_data)

                                try:
                                    await cur_session.send_realtime_input(
                                        media=types.Blob(mime_type=mime_type, data=raw_bytes)
                                    )
                                except Exception as inner_e:
                                    err_str = str(inner_e)
                                    if "1011" in err_str or "close" in err_str.lower():
                                        print(f"[Receive Task] Gemini session died (1011). Will reconnect.")
                                        return
                                    print(f"[Receive Task] Error sending audio to Gemini: {inner_e}")
                            elif payload.get("type") == "user_interrupt":
                                # User clicked something in the graphic — immediately send clear
                                # so the frontend can reset audio muting and play new audio ASAP
                                async with ws_lock:
                                    await websocket.send_json({"type": "clear"})
                                # Immediately interrupt Gemini's current generation.
                                # turn_complete=False = "more context coming, stop talking but don't respond yet"
                                try:
                                    await cur_session.send_client_content(
                                        turns=[types.Content(parts=[types.Part.from_text(
                                            text="[The user is interacting with the graphic right now]"
                                        )])],
                                        turn_complete=False
                                    )
                                except Exception:
                                    pass

                            elif payload.get("type") == "start_live_session":
                                # Eager path: user clicked Start — flush buffered Gemini responses
                                if not eager_flushed.is_set():
                                    t0 = time.time()
                                    session_holder["t0"] = t0
                                    session_holder["first_audio_sent"] = False
                                    await websocket.send_json({"type": "phase", "phase": "conversation"})
                                    async with ws_lock:
                                        await websocket.send_json({"type": "ready"})
                                    buf_count = len(eager_buffer)
                                    for msg in eager_buffer:
                                        async with ws_lock:
                                            await websocket.send_json(msg)
                                    eager_buffer.clear()
                                    eager_flushed.set()
                                    print(f"[TIMING] T+{time.time()-t0:.3f}s: EAGER flush — {buf_count} buffered messages sent")

                            elif payload.get("type") == "end_live_session":
                                print("[Receive Task] User ended session")
                                session_holder["alive"] = False
                                return  # Exit relay — Gemini closes, WS stays open

                            elif "clientContent" in payload:
                                try:
                                    text = payload["clientContent"]["turns"][0]["parts"][0]["text"]
                                    turn_complete = payload["clientContent"].get("turnComplete", True)
                                    if "[System Status:" in text:
                                        print(f"[LATENCY] Backend received interaction text at {time.time():.3f}: {text[:80]}...")
                                    await cur_session.send_client_content(
                                        turns=[types.Content(parts=[types.Part.from_text(text=text)])],
                                        turn_complete=turn_complete
                                    )
                                    if "[System Status:" in text:
                                        print(f"[LATENCY] Forwarded to Gemini at {time.time():.3f}")
                                except Exception as inner_e:
                                    err_str = str(inner_e)
                                    if "1011" in err_str or "close" in err_str.lower():
                                        print(f"[Receive Task] Gemini session died while sending text. Will reconnect.")
                                        return
                                    print(f"[Receive Task] Error sending text to Gemini: {inner_e}")

                    except WebSocketDisconnect:
                        print("[Receive Task] Client WebSocket Disconnected normally.")
                        client_disconnected.set()
                        session_holder["alive"] = False
                    except asyncio.CancelledError:
                        pass
                    except Exception as e:
                        print(f"[Receive Task] Error/Disconnected: {type(e).__name__} - {e}")

                # ------------------------------------------------------------------
                # GEMINI → CLIENT relay (with GoAway & resumption handle tracking)
                # ------------------------------------------------------------------
                async def receive_from_gemini_and_send_to_client():
                    nonlocal resumption_handle
                    interrupted = False
                    error_1011_count = 0
                    while True:
                        try:
                            async for response in session.receive():
                                # --- Track session resumption handles ---
                                if response.session_resumption_update:
                                    update = response.session_resumption_update
                                    if getattr(update, "resumable", False) and getattr(update, "new_handle", None):
                                        resumption_handle = update.new_handle
                                        print(f"[Gemini] ✅ Resumption handle stored")

                                # --- Handle GoAway (proactive reconnection) ---
                                if response.go_away:
                                    time_left = getattr(response.go_away, "time_left", "unknown")
                                    print(f"[Gemini] ⚠️ GoAway received — connection closing in {time_left}")
                                    go_away_event.set()
                                    # Don't break — let current response finish, then the outer loop will reconnect

                                server_content = response.server_content
                                if server_content:
                                    if getattr(server_content, "interrupted", False):
                                        print("[Gemini] User Interruption Detected! Halting queue...")
                                        interrupted = True
                                        if eager_flushed.is_set():
                                            async with ws_lock:
                                                await websocket.send_json({"type": "clear"})
                                        else:
                                            eager_buffer.append({"type": "clear"})
                                        continue

                                if server_content and server_content.model_turn:
                                    interrupted = False
                                    error_1011_count = 0
                                    for part in server_content.model_turn.parts:
                                        if part.inline_data:
                                            audio_base64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                            audio_msg = {
                                                "type": "audio",
                                                "mimeType": part.inline_data.mime_type,
                                                "data": audio_base64
                                            }
                                            if eager_flushed.is_set():
                                                if not session_holder.get("first_audio_sent"):
                                                    session_holder["first_audio_sent"] = True
                                                    _t0 = session_holder.get("t0")
                                                    if _t0:
                                                        print(f"[TIMING] T+{time.time()-_t0:.3f}s: first audio chunk sent to frontend")
                                                async with ws_lock:
                                                    await websocket.send_json(audio_msg)
                                            else:
                                                eager_buffer.append(audio_msg)
                                                # Signal frontend when first audio is buffered (AI is warmed up)
                                                if not session_holder.get("eager_audio_signaled"):
                                                    session_holder["eager_audio_signaled"] = True
                                                    async with ws_lock:
                                                        await websocket.send_json({"type": "eager_audio_ready"})
                                                    print(f"[Eager] First audio buffered — signaled frontend")

                                # Check turnComplete — if GoAway was received, now is safe to reconnect
                                if server_content and getattr(server_content, "turn_complete", False):
                                    if go_away_event.is_set():
                                        print("[Gemini] Turn complete after GoAway — triggering reconnection.")
                                        return  # Exit to outer reconnection loop

                                # Handle Tool Calls
                                if response.tool_call:
                                    if interrupted:
                                        # Only skip cosmetic tools — actionable tools (click, modify) should always execute
                                        skippable = {"highlight_element", "navigate_to_section", "zoom_view"}
                                        actionable_calls = [fc for fc in response.tool_call.function_calls if fc.name not in skippable]
                                        skipped_calls = [fc for fc in response.tool_call.function_calls if fc.name in skippable]
                                        if skipped_calls:
                                            print(f"[Tool Call] Skipping {len(skipped_calls)} cosmetic tool call(s) due to interruption")
                                        if not actionable_calls:
                                            interrupted = False
                                            continue
                                        # Process only actionable calls — rebuild the tool_call with filtered list
                                        interrupted = False

                                    func_responses = []
                                    for func_call in response.tool_call.function_calls:
                                        tool_name = func_call.name
                                        tool_args = dict(func_call.args) if func_call.args else {}
                                        print(f"\n[AI TOOL FIRING] {tool_name}({json.dumps(tool_args)})")

                                        if tool_name in ("highlight_element", "navigate_to_section", "zoom_view", "modify_element", "click_element"):
                                            tool_msg = {
                                                "type": "tool_action",
                                                "action": tool_name,
                                                "params": tool_args
                                            }
                                            if eager_flushed.is_set():
                                                async with ws_lock:
                                                    await websocket.send_json(tool_msg)
                                            else:
                                                eager_buffer.append(tool_msg)
                                            # For click_element, provide richer feedback so AI can self-correct
                                            if tool_name == "click_element":
                                                kw = tool_args.get("element_id", "")
                                                # DEBUG LOG to see exactly what AI is sending
                                                with open("/tmp/click_debug.log", "a") as df:
                                                    df.write(f"CLICK_ELEMENT called with keyword: {kw}\n")
                                                    
                                                controls_inv = cached_controls_inv
                                                resp_msg = (
                                                    f"click_element dispatched with keyword '{kw}'. "
                                                    f"IMPORTANT: If the keyword does not exactly match a button below, the click will silently fail. "
                                                    f"Available controls:\n{controls_inv}"
                                                )
                                                tool_response_body = {"result": "dispatched", "message": resp_msg}
                                            else:
                                                tool_response_body = {"result": "ok", "message": f"{tool_name} executed on the user's screen."}
                                            func_responses.append(
                                                types.FunctionResponse(
                                                    name=func_call.name,
                                                    id=func_call.id,
                                                    response=tool_response_body
                                                )
                                            )

                                        elif tool_name == "fetch_more_detail":
                                            query = tool_args.get("query", "")
                                            print(f"[Tool Call] Fetching more detail: {query}")
                                            async with ws_lock:
                                                await websocket.send_json({
                                                    "type": "tool_action",
                                                    "action": "fetch_more_detail",
                                                    "params": {"query": query, "status": "searching"}
                                                })
                                            fetch_citations: list[dict] = []
                                            try:
                                                search_response = await asyncio.to_thread(
                                                    pro_client.models.generate_content,
                                                    model='gemini-2.5-flash',
                                                    contents=f"Provide a concise, factual summary about: {query}",
                                                    config=types.GenerateContentConfig(
                                                        tools=[types.Tool(google_search=types.GoogleSearch())]
                                                    )
                                                )
                                                result_text = search_response.text[:2000] if search_response.text else "No results found."

                                                # Improvement B: extract grounding citations from the sidecar search
                                                try:
                                                    gm = search_response.candidates[0].grounding_metadata if search_response.candidates else None
                                                    if gm:
                                                        for chunk in (getattr(gm, "grounding_chunks", []) or []):
                                                            web = getattr(chunk, "web", None)
                                                            if web:
                                                                uri = getattr(web, "uri", None)
                                                                title = getattr(web, "title", None) or uri
                                                                if uri and not any(c["url"] == uri for c in fetch_citations):
                                                                    fetch_citations.append({"title": title, "url": uri})
                                                        print(f"[Grounding] fetch_more_detail: {len(fetch_citations)} citation(s) for query '{query}'")
                                                except Exception as meta_err:
                                                    print(f"[Grounding] fetch_more_detail metadata error: {meta_err}")

                                            except Exception as fetch_err:
                                                print(f"[Tool Call] fetch_more_detail error: {fetch_err}")
                                                result_text = f"Could not fetch information: {fetch_err}"

                                            async with ws_lock:
                                                await websocket.send_json({
                                                    "type": "tool_action",
                                                    "action": "fetch_more_detail",
                                                    "params": {"query": query, "status": "complete"}
                                                })
                                                # Improvement B: send citations to frontend
                                                if fetch_citations:
                                                    await websocket.send_json({
                                                        "type": "grounding_sources",
                                                        "context": "fetch_more_detail",
                                                        "query": query,
                                                        "sources": fetch_citations
                                                    })
                                            func_responses.append(
                                                types.FunctionResponse(
                                                    name=func_call.name,
                                                    id=func_call.id,
                                                    response={"result": result_text}
                                                )
                                            )

                                        elif tool_name == "show_interactive_graphic":
                                            async with ws_lock:
                                                await websocket.send_json({
                                                    "type": "interactive_svg",
                                                    "svg_html": svg_html
                                                })
                                            func_responses.append(
                                                types.FunctionResponse(
                                                    name=func_call.name,
                                                    id=func_call.id,
                                                    response={"result": "ok"}
                                                )
                                            )

                                        else:
                                            print(f"[Tool Call] Unknown tool: {tool_name}")
                                            func_responses.append(
                                                types.FunctionResponse(
                                                    name=func_call.name,
                                                    id=func_call.id,
                                                    response={"error": f"Unknown tool: {tool_name}"}
                                                )
                                            )

                                    if func_responses:
                                        try:
                                            await session.send_tool_response(function_responses=func_responses)
                                        except Exception as e:
                                            print(f"[Gemini Task] Warning: Failed to send tool response: {e}")

                        except APIError as e:
                            if "1011" in str(e):
                                error_1011_count += 1
                                print(f"[Gemini Task] Trapped 1011 APIError ({error_1011_count}/3). Resuming...")
                                interrupted = False
                                if error_1011_count >= 3:
                                    print("[Gemini Task] Too many 1011 errors, ending session.")
                                    break
                                await asyncio.sleep(0.5)
                                continue
                            else:
                                print(f"[Gemini Task] Fatal APIError: {e}")
                                break
                        except WebSocketDisconnect:
                            print("[Gemini Task] Client WebSocket Disconnected normally.")
                            client_disconnected.set()
                            session_holder["alive"] = False
                            break
                        except asyncio.CancelledError:
                            print("[Gemini Task] Task cancelled.")
                            break
                        except Exception as e:
                            print(f"[Gemini Task] Error/Disconnected: {type(e).__name__} - {e}")
                            break

                # ------------------------------------------------------------------
                # KEEP-ALIVE: send silent audio every 25 seconds to prevent idle timeout
                # ------------------------------------------------------------------
                async def keep_alive_ping():
                    """Send a minimal silent audio blob every 25s to prevent idle disconnects."""
                    # 160 bytes of silence = 10ms of 16kHz 16-bit PCM
                    silent_blob = types.Blob(mime_type="audio/pcm;rate=16000", data=b'\x00' * 160)
                    try:
                        while session_holder["alive"]:
                            await asyncio.sleep(25)
                            cur_session = session_holder["session"]
                            if cur_session:
                                try:
                                    await cur_session.send_realtime_input(media=silent_blob)
                                except Exception:
                                    pass  # Session might be closing, that's fine
                    except asyncio.CancelledError:
                        pass

                # ------------------------------------------------------------------
                # Run all three tasks concurrently. If any exits, cancel the others.
                # ------------------------------------------------------------------
                receive_task = asyncio.create_task(receive_from_client_and_send_to_gemini())
                gemini_task = asyncio.create_task(receive_from_gemini_and_send_to_client())
                keepalive_task = asyncio.create_task(keep_alive_ping())

                # On first connection: send initial prompt immediately.
                # Mic audio is already flowing from the frontend (setupMic runs
                # before start_live_session is sent), so no need to wait.
                if not session_holder.get("prompted"):
                    session_holder["prompted"] = True
                    print(f"[TIMING] T+{time.time()-t0:.3f}s: sending initial prompt to Gemini")
                    try:
                        await session.send_client_content(
                            turns=[types.Content(parts=[types.Part.from_text(
                                text="The user just joined the session. Begin your welcome and overview now. Start speaking IMMEDIATELY — do NOT use any tools (highlight, click, etc.) until AFTER you have finished your initial welcome greeting. Get your voice to the user as fast as possible. After greeting, silently start auto-play (if available) without mentioning it — just click the button and begin narrating the content."
                            )])]
                        )
                        print(f"[TIMING] T+{time.time()-t0:.3f}s: initial prompt sent")
                    except Exception as e:
                        print(f"[Gemini] Error sending initial prompt: {e}")

                done, pending = await asyncio.wait(
                    [receive_task, gemini_task, keepalive_task],
                    return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()

                # Clear session reference while reconnecting
                session_holder["session"] = None

            # --- End of `async with ... as session` ---
            # If we got here due to GoAway and have a handle, loop will reconnect.
            # Otherwise, a normal exit or error — check if we should retry.
            if go_away_event.is_set() and resumption_handle:
                go_away_event.clear()
                print("[Gemini] Performing proactive GoAway reconnection...")
                await asyncio.sleep(0.2)  # Brief pause before reconnect
                continue
            elif not session_holder["alive"] or client_disconnected.is_set():
                break
            elif resumption_handle:
                # Unexpected disconnect but we have a handle — try to resume
                reconnect_count += 1
                if reconnect_count > MAX_RECONNECT_ATTEMPTS:
                    print(f"[Gemini] Max reconnect attempts ({MAX_RECONNECT_ATTEMPTS}) exceeded. Ending session.")
                    break
                print(f"[Gemini] Unexpected disconnect. Attempting reconnection ({reconnect_count}/{MAX_RECONNECT_ATTEMPTS})...")
                await asyncio.sleep(1.0 * reconnect_count)  # Backoff: 1s, 2s, 3s
                continue
            else:
                break

        except Exception as e:
            print(f"[Gemini] Connection error: {type(e).__name__} - {e}")
            reconnect_count += 1
            if reconnect_count > MAX_RECONNECT_ATTEMPTS or not resumption_handle:
                print(f"[Gemini] Cannot reconnect. Ending session.")
                break
            print(f"[Gemini] Will retry in {reconnect_count}s...")
            await asyncio.sleep(1.0 * reconnect_count)

    # Return True if WS is still alive (user ended session), False if client disconnected
    ws_still_alive = not client_disconnected.is_set()
    if ws_still_alive:
        print("[Live Session] Session ended. WebSocket kept alive for fast reconnect.")
        # Send phase:complete so frontend shows "Start Live Conversation" button again
        try:
            await websocket.send_json({"type": "phase", "phase": "complete"})
        except Exception:
            ws_still_alive = False
    else:
        print("[Live Session] Client disconnected.")
    return ws_still_alive
