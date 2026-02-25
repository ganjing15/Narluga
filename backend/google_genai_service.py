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

load_dotenv()

# We need a global async client for the pro sidecar
pro_client = genai.Client()

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
                        for attempt in range(18):  # 90 seconds max
                            await asyncio.sleep(5)
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


def is_youtube_url(url: str) -> bool:
    """Check if a URL is a YouTube video URL."""
    return bool(extract_youtube_video_id(url))


async def gather_source_content(sources: list, send_status) -> tuple[str, list[str]]:
    """
    Process all sources and return combined content + list of source labels.
    sources: [{ type: 'url'|'youtube'|'text'|'file', content: str, label: str }]
    """
    combined_parts = []
    source_labels = []
    
    for i, source in enumerate(sources):
        src_type = source.get("type", "text")
        content = source.get("content", "")
        label = source.get("label", f"Source {i+1}")
        source_labels.append(label)
        
        await send_status(f"Reading source {i+1}/{len(sources)}: {label[:50]}...")
        
        if src_type == "url":
            text = await fetch_website_content(content)
            combined_parts.append(f"=== SOURCE: {label} (Web Page) ===\n{text}")
        elif src_type == "youtube":
            text = await fetch_youtube_transcript(content)
            combined_parts.append(f"=== SOURCE: {label} (YouTube Video Transcript) ===\n{text}")
        elif src_type == "file":
            # content already contains the extracted text from the upload endpoint
            combined_parts.append(f"=== SOURCE: {label} (Uploaded File) ===\n{content}")
        elif src_type == "text":
            combined_parts.append(f"=== SOURCE: User Text Input ===\n{content}")
        else:
            combined_parts.append(f"=== SOURCE: {label} ===\n{content}")
    
    combined_content = "\n\n".join(combined_parts)
    return combined_content, source_labels


def should_use_web_search(sources: list) -> bool:
    """Determine if web search grounding should be used (short text input only)."""
    if len(sources) != 1:
        return False
    source = sources[0]
    if source.get("type") != "text":
        return False
    content = source.get("content", "")
    word_count = len(content.split())
    return word_count < 100


async def generate_presentation_plan(combined_content: str, source_labels: list, use_web_search: bool = False) -> str:
    """Uses Gemini to digest the sources and output an Interactive Graphic."""
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
    1. SCIENTIFIC & PHYSICAL ACCURACY: Your diagrams must be strictly logically, geometrically, and physically correct!
       - If drawing astronomical/physical shadows (like the Earth's terminator), remember that the shadow is cast from an external light source. Only rotate the physical object, NOT the shadow.
       - If drawing mechanical gears or chemical bonds, the sizes, ratios, and angles must be mathematically plausible. Do not place elements haphazardly.
    2. VISUAL STYLE: You MUST use a **world-class, premium, modern UI aesthetic**! It must look professionally designed.
       - Use a sophisticated, modern color palette: Slate grays for text (#0f172a, #334155), crisp white or very soft slate (#f8fafc) backgrounds, and a single elegant primary accent color (e.g., Royal Blue #2563eb or Emerald #059669).
       - Typography is critical: Use standard sans-serif system fonts (e.g. system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto) with proper hierarchy.
       - Use **generous whitespace/padding** everywhere.
       - The SVG vectors themselves should be elegantly simple, thick, perfectly symmetric, and use soft refined gradients or solid clean colors. Limit the number of visual elements to 5-10 maximum.
    3. FORMAT & SEPARATION: DO NOT output an outer flexbox wrapper. We are injecting your `<svg-panel>` and `<controls-panel>` blocks directly into our own layout. The `<svg-panel>` should contain your visual SVG. The `<controls-panel>` should contain your HTML controls. Each should use width/height `100%`. DO NOT ADD white backgrounds, borders, or box-shadows to these core containers, as our parent React cards handle the styling.
    3. ADVANCED INTERACTIVITY & STATE: You must generate deeply interactive graphics, not just static diagrams with click-to-highlight buttons.
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
         <input type="range" id="timeSlider" min="0" max="100" value="0" oninput="updateState(this.value)">
         <button class="ctrl-btn" onclick="togglePlay()">▶ Auto-Play</button>
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
         if (isPlaying) {{
           playInterval = setInterval(() => {{
             let slider = document.getElementById('timeSlider');
             let nextVal = (Number(slider.value) + 1) % 100;
             slider.value = nextVal;
             updateState(nextVal);
           }}, 50);
         }} else {{
           clearInterval(playInterval);
         }}
       }}
       </script>
       ```

       CRITICAL: You are NOT limited to highlight colors. Build physical interactivity tailored to the concept—sliders that orbit, buttons that pump data flows, switches that change day/night, etc. You must still include `<g id="node-XXX">` and use `transform-box: fill-box;` for any nodes you animate via CSS.

    4. ANIMATION: The SVG must have animated elements. Use CSS @keyframes for idle animations (pulsing, rotating, dashed line flow). All node groups need `transition: all 0.3s ease` for smooth highlight effects.
    5. NO BORDER RADIUS ON SVG: Keep `<svg>` elements square/rectangular. Do not use `border-radius` on `<svg>`.
    6. ANIMATION STATE TEXT: If you add play/pause buttons, the active/playing state button MUST contain the text "Pause" or "Stop" (e.g., "⏸ Pause Orbit"). The inactive/paused state MUST contain "Play" or "Start" (e.g., "▶ Auto-Grow"). 
       - CRUCIAL FOR LIVE AI: When you receive an interaction event saying the user clicked a button labeled "Pause" or "Stop", it means the animation is NOW PLAYING (because the button offers the option to pause it). When you receive an event that they clicked "Play" or "Start", it means the animation is NOW PAUSED. Always narrate the state it transitioned INTO, not the label of the button.
    7. TEXT WRAPPING: SVG text elements do not auto-wrap. Use foreignObject with explicit width/height for any text longer than 3 words. Inner div must use `overflow:hidden; word-wrap:break-word; box-sizing:border-box; padding:4px;`.
    8. NARRATION: Write a concise 1-paragraph summary in `<narration>...</narration>` tags describing the diagram for a voice assistant.
    9. SVG CLEANLINESS: The svg-panel must contain ONLY the visual diagram — NO paragraphs of text. Short labels (1-3 words) are OK. All explanations go in controls-panel.
    10. LABEL READABILITY: Place text labels LAST in SVG markup (painter's model). Add a semi-transparent white rect behind each label. Use font-weight bold and 14px+ size.

    Source Content:
    {combined_content[:40000]}
    """
    
    print("[Planner] Generating presentation plan using Gemini 3.1 Pro Preview...")
    try:
        # Build generation config
        gen_kwargs = {
            "model": 'gemini-3.1-pro-preview',
            "contents": prompt,
        }
        
        # Add web search grounding for short text inputs
        if use_web_search:
            print("[Planner] Using Google Search grounding for short text input")
            gen_kwargs["config"] = types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )
        
        response = await asyncio.to_thread(
            pro_client.models.generate_content,
            **gen_kwargs
        )
        print(f"[Planner] Plan generated successfully. Raw Output Length: {len(response.text)}\n")
        return response.text
    except Exception as e:
        print(f"[Planner] Error: {e}")
        return ""

async def handle_live_session(websocket: WebSocket, sources: list):
    """
    Manages the realtime WebSocket connection bridging the frontend and Gemini Live API.
    Now accepts a list of sources instead of a single URL.
    """
    
    # Helper to send status updates
    async def send_status(message: str):
        try:
            await websocket.send_json({"type": "status", "message": message})
        except:
            pass
    
    # 1. Phase 1: Source Gathering & Planning
    await send_status("Analyzing sources...")
    await websocket.send_json({"type": "phase", "phase": "analyzing"})
    
    combined_content, source_labels = await gather_source_content(sources, send_status)
    
    use_search = should_use_web_search(sources)
    
    await send_status("Designing interactive animated graphic...")
    await websocket.send_json({"type": "phase", "phase": "designing"})
    
    interactive_graphic_plan_raw = await generate_presentation_plan(combined_content, source_labels, use_search)
    
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
        
    # Send the SVG and Controls directly to the frontend
    await websocket.send_json({
        "type": "interactive_svg",
        "svg_html": svg_html,
        "controls_html": controls_html,
        "title": title,
        "subtitle": subtitle,
        "narration_context": narration_context,
        "source_labels": source_labels
    })
    
    # Signal graphic is complete
    await websocket.send_json({"type": "phase", "phase": "complete"})
    
    # 2. Phase 2: Live Presenter — delegate to shared helper
    await _run_live_session(websocket, narration_context, source_labels, svg_html, controls_html)


async def handle_live_restart(websocket: WebSocket, narration_context: str, source_labels: list[str], svg_html: str, controls_html: str = ""):
    """
    Restart a live conversation on an existing graphic.
    Skips graphic generation and goes straight to the Live API.
    """
    print(f"[Live Restart] Starting with {len(source_labels)} source label(s)")
    await _run_live_session(websocket, narration_context, source_labels, svg_html, controls_html)


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
            if text:
                onclick = btn.get("onclick", "")
                text_lower = text.lower()
                # Detect toggle/play-pause buttons
                is_toggle = any(kw in onclick.lower() for kw in ["toggleplay", "toggle", "isplaying", "autoplay", "auto_play", "toggleflight", "toggleanim"])
                has_play_text = any(kw in text_lower for kw in ["play", "start", "auto", "▶", "resume", "begin", "launch"])
                has_pause_text = any(kw in text_lower for kw in ["pause", "stop", "⏸", "halt", "‖"])
                if is_toggle or has_play_text or has_pause_text:
                    items.append(f'- Button (toggle): "{text}" — toggles play/pause. The label shows what the NEXT action will be (opposite of current state).')
                else:
                    items.append(f'- Button: "{text}"')
        # Find sliders/range inputs
        for inp in search_root.find_all("input"):
            inp_type = inp.get("type", "text")
            # Build a descriptive label from multiple sources
            label = inp.get("aria-label") or inp.get("title") or ""
            if not label:
                # Check for a nearby label element
                inp_id = inp.get("id", "")
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
                items.append(f'- Slider: "{label}" (range: {min_val}–{max_val}, current: {cur_val}). NOTE: You cannot drag sliders directly — tell the user to adjust it manually.')
            else:
                items.append(f'- Input ({inp_type}): "{label}"')
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


async def _run_live_session(websocket: WebSocket, narration_context: str, source_labels: list[str], svg_html: str, controls_html: str = ""):
    """
    Shared Live API session logic. Handles system instruction, tool declarations,
    Gemini connection, and bidirectional audio/tool streaming.
    """
    # Build source description for system instruction
    source_desc = ", ".join(source_labels) if source_labels else "the provided content"
    
    system_instruction = f"""\
    You are Narluga, an expert and charismatic Interactive Guide. You accompany the user as they explore an interactive, animated SVG diagram about: {source_desc}.
    
    You have access to TOOLS that let you manipulate the diagram in real-time. You can highlight elements, navigate to sections, zoom in/out, and fetch more info. Use them when they add value — but don't force them. Your voice is the primary medium.
    
    Here is the narration context from the diagram:
    
    <diagram_context>
    {narration_context}
    </diagram_context>
    
    Here are the ACTUAL interactive controls available in the diagram's control panel:
    
    <available_controls>
    {_extract_controls_inventory(svg_html, controls_html)}
    </available_controls>
    
    YOUR BEHAVIOR:
    1. Welcome the user warmly. Give a 2-3 sentence summary of what the graphic shows.
    2. Then invite the user to explore: "What part would you like to dive into?"
    3. When the user asks about a concept, explain it clearly. Use `highlight_element` to point out the relevant part if helpful.
    4. Use `navigate_to_section` only when moving between distinctly different areas of the diagram.
    5. Use `zoom_view` sparingly — only if the user asks to see details up close.
    6. If the user asks about something not in the diagram, use `fetch_more_detail` to search for it.
    7. If the user asks you to CHANGE the graphic (e.g., "make it red", "hide the clouds", "make the sun bigger"), use `modify_element` to update the CSS in real-time.
    8. If the user asks you to interact with UI controls, use `click_element` to click that button — but ONLY if the button actually exists in <available_controls> above.
    9. Keep responses concise and conversational. You're a tutor, not a lecturer.
    10. NEVER mention or reference buttons, controls, or UI elements that don't appear in <available_controls>. If a control doesn't exist, tell the user what IS available instead.
    11. CURSOR AWARENESS: You will receive "[Cursor position: ...]" messages telling you where the user's cursor is on the diagram. When you see these, briefly acknowledge what they're pointing at (e.g., "I see you're looking at the Database node — that's where...") and offer a short explanation. Don't repeat the same explanation if they stay on the same element. Don't interrupt yourself mid-sentence to acknowledge cursor moves.
    12. PLAY/PAUSE STATE: When you receive an interaction event saying a toggle button was clicked, pay attention to the RESULTING STATE reported in the event (e.g., "now PLAYING" or "now PAUSED"). The button label shows what the NEXT action will be, which is the OPPOSITE of the current state. For example, a button that says "▶ Play" means the animation is currently PAUSED. A button that says "⏸ Pause" means it is currently PLAYING. After auto-play starts, briefly narrate what is animating on screen.
    13. AUTO-PLAY CAPABILITY: If a toggle button exists in <available_controls> (e.g., "▶ Auto-Process Data"), you CAN and SHOULD use click_element to start or stop it when the user asks. Just use the keyword from the button text.
    14. SLIDERS/RANGE INPUTS: If a slider/range input exists in <available_controls>, you CANNOT drag it programmatically. Instead, tell the user to adjust it manually and describe what it controls.
    
    TOOL TIPS:
    - Call ONE tool at a time, not multiple simultaneously.
    - Always speak while or after using a tool — never go silent after a tool call.
    - The element_id for tools should match labels or keywords visible in the diagram.
    - For modify_element, prioritize CSS properties like 'display', 'opacity', 'scale', 'fill', or 'color'. This safely avoids breaking existing animation transforms.
      - E.g., to resize an element, use css_property 'scale' and value '2' or '0.5'. (Do NOT use 'transform').
      - E.g., to hide an element, use css_property 'display' and value 'none'.
      - E.g., to recolor, use css_property 'fill' and a hex value.
    - For click_element, match the exact button text from <available_controls>.
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
                description="Modify the visual appearance of an element in the SVG diagram in real-time. Use this when the user asks you to change something about the graphic (e.g., 'make the sun bigger', 'change the ocean to green', 'hide the clouds'). You can change any CSS property.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        element_id=types.Schema(
                            type="STRING",
                            description="A keyword or identifier for the element to modify. Should match visible labels, text, or section names in the diagram."
                        ),
                        css_property=types.Schema(
                            type="STRING",
                            description="The CSS property to change. Common ones: 'fill' (color), 'opacity' (0-1), 'transform' (e.g. 'scale(1.5)'), 'display' ('none' to hide, 'block' to show), 'stroke', 'stroke-width', 'font-size', 'visibility' ('hidden'/'visible')."
                        ),
                        value=types.Schema(
                            type="STRING",
                            description="The new value for the CSS property. E.g., '#ef4444' for red fill, '0.5' for semi-transparent, 'scale(2)' to double size, 'none' to hide."
                        )
                    ),
                    required=["element_id", "css_property", "value"]
                )
            ),
            types.FunctionDeclaration(
                name="click_element",
                description="Programmatically click a button or interactive element in the diagram or its controls panel. Use this when the user asks you to interact with the UI controls (e.g., 'stop the autoplay', 'click the Evaporation button', 'press Play', 'toggle the switch'). This simulates a real mouse click.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties=dict(
                        element_id=types.Schema(
                            type="STRING",
                            description="A keyword matching the button text, label, or ID to click. E.g., 'Play', 'Stop', 'Evaporation', 'Reset', 'Auto-Cycle'. Match the exact text shown on the button."
                        )
                    ),
                    required=["element_id"]
                )
            ),
        ])
    ]
    
    # We must use the asynchronous client for the Live API
    client = genai.Client(http_options={'api_version': 'v1alpha'})
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
                trigger_tokens=50000  # Compress at ~80% of typical limit
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
    
    # --------------------------------------------------------------------------------
    # 2. WAIT FOR USER TO START PRESENTATION
    # --------------------------------------------------------------------------------
    print("[WebSocket] Waiting for user to start presentation...")
    initial_events = []
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            if payload.get("type") == "start_live_session":
                initial_events = payload.get("pre_events", [])
                break
    except WebSocketDisconnect:
        print("[WebSocket] Client disconnected before starting session.")
        return
    except Exception as e:
        print(f"[WebSocket] Error while waiting to start: {e}")
        return

    # Signal conversation phase
    await websocket.send_json({"type": "phase", "phase": "conversation"})

    # --------------------------------------------------------------------------------
    # 3. Phase 2: Live Presenter — Reconnection Loop
    # --------------------------------------------------------------------------------
    MAX_RECONNECT_ATTEMPTS = 3
    reconnect_count = 0
    is_first_connection = True

    while session_holder["alive"] and not client_disconnected.is_set():
        # Build config (with resumption handle for reconnections)
        if not is_first_connection and resumption_handle:
            config = _build_config(handle=resumption_handle)
            print(f"[Gemini] Reconnecting with resumption handle...")
        elif not is_first_connection:
            print("[Gemini] No resumption handle available, cannot reconnect.")
            break

        try:
            print("[Gemini] Attempting to connect to Live API...")
            async with client.aio.live.connect(model=model, config=config) as session:
                session_holder["session"] = session
                go_away_event.clear()
                reconnect_count = 0  # Reset on successful connection
                print("[Gemini] Connected to Live API")

                if is_first_connection:
                    is_first_connection = False
                    # Drop stale pre-session events
                    if initial_events:
                        print(f"[Gemini] Dropping {len(initial_events)} stale pre-session event(s) to prevent double overview.")

                    async with ws_lock:
                        await websocket.send_json({"type": "ready"})

                    # Kick off the conversation — send a prompt so the AI starts talking immediately
                    # Wait 1.2s to let the mic stabilize and avoid VAD false-triggers
                    try:
                        await asyncio.sleep(1.2)
                        await session.send_client_content(
                            turns=[types.Content(parts=[types.Part.from_text(
                                text="The user just joined the session. Begin your welcome and overview now."
                            )])]
                        )
                    except Exception as e:
                        print(f"[Gemini] Error sending initial prompt: {e}")
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
                                        return  # Let the outer loop handle reconnection
                                    print(f"[Receive Task] Error sending audio to Gemini: {inner_e}")
                            elif "clientContent" in payload:
                                try:
                                    text = payload["clientContent"]["turns"][0]["parts"][0]["text"]
                                    await cur_session.send_client_content(
                                        turns=[types.Content(parts=[types.Part.from_text(text=text)])]
                                    )
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
                                        async with ws_lock:
                                            await websocket.send_json({"type": "clear"})
                                        continue

                                if server_content and server_content.model_turn:
                                    interrupted = False
                                    error_1011_count = 0
                                    for part in server_content.model_turn.parts:
                                        if part.inline_data:
                                            audio_base64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                            async with ws_lock:
                                                await websocket.send_json({
                                                    "type": "audio",
                                                    "mimeType": part.inline_data.mime_type,
                                                    "data": audio_base64
                                                })

                                # Check turnComplete — if GoAway was received, now is safe to reconnect
                                if server_content and getattr(server_content, "turn_complete", False):
                                    if go_away_event.is_set():
                                        print("[Gemini] Turn complete after GoAway — triggering reconnection.")
                                        return  # Exit to outer reconnection loop

                                # Handle Tool Calls
                                if response.tool_call:
                                    if interrupted:
                                        print(f"[Tool Call] Skipping {len(response.tool_call.function_calls)} tool call(s) due to interruption")
                                        interrupted = False
                                        continue

                                    func_responses = []
                                    for func_call in response.tool_call.function_calls:
                                        tool_name = func_call.name
                                        tool_args = dict(func_call.args) if func_call.args else {}
                                        print(f"\n[AI TOOL FIRING] {tool_name}({json.dumps(tool_args)})")

                                        if tool_name in ("highlight_element", "navigate_to_section", "zoom_view", "modify_element", "click_element"):
                                            async with ws_lock:
                                                await websocket.send_json({
                                                    "type": "tool_action",
                                                    "action": tool_name,
                                                    "params": tool_args
                                                })
                                            func_responses.append(
                                                types.FunctionResponse(
                                                    name=func_call.name,
                                                    id=func_call.id,
                                                    response={"result": "ok", "message": f"{tool_name} executed on the user's screen."}
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
                                            except Exception as fetch_err:
                                                print(f"[Tool Call] fetch_more_detail error: {fetch_err}")
                                                result_text = f"Could not fetch information: {fetch_err}"

                                            async with ws_lock:
                                                await websocket.send_json({
                                                    "type": "tool_action",
                                                    "action": "fetch_more_detail",
                                                    "params": {"query": query, "status": "complete"}
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

    print("[Live Session] Complete/Terminated.")

    # Send a clean WebSocket close so the frontend gets a 1000 instead of 1006
    try:
        await websocket.close(code=1000, reason="Live session ended. Click 'Start Live Conversation' to reconnect.")
    except Exception:
        pass  # Already closed by client
