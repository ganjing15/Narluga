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
    1. VISUAL STYLE: You MUST use a **world-class, premium, modern UI aesthetic**! It must look professionally designed.
       - Use a sophisticated, modern color palette: Slate grays for text (#0f172a, #334155), crisp white or very soft slate (#f8fafc) backgrounds, and a single elegant primary accent color (e.g., Royal Blue #2563eb or Emerald #059669).
       - Typography is critical: Use standard sans-serif system fonts (e.g. system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto) with proper hierarchy.
       - Use **generous whitespace/padding** everywhere.
       - The SVG vectors themselves should be elegantly simple, thick, perfectly symmetric, and use soft refined gradients or solid clean colors. Limit the number of visual elements to 5-10 maximum.
    2. FORMAT & SEPARATION: DO NOT output an outer flexbox wrapper. We are injecting your `<svg-panel>` and `<controls-panel>` blocks directly into our own layout. The `<svg-panel>` should contain your visual SVG. The `<controls-panel>` should contain your HTML controls. Each should use width/height `100%`. DO NOT ADD white backgrounds, borders, or box-shadows to these core containers, as our parent React cards handle the styling.
    3. UI CONTROLS: The `<controls-panel>` should contain ONLY interactive elements (sliders, buttons, toggles) and dynamic values that update based on user interaction. Style them with modern CSS — put your `<style>` tags in the `<controls-panel>`. DO NOT include a title, subtitle, heading, or introductory description in the controls panel — the app already displays those above the graphic. Jump straight into the controls.
    4. ANIMATION & LOGIC: It MUST be animated! The SVG components should respond to the HTML UI controls via JavaScript. Include `<style>` tags with CSS `@keyframes` and smooth transitions.
    5. JAVASCRIPT: Include embedded `<script>` tags in `<controls-panel>` to wire up the interactivity. DO NOT use `document.addEventListener` for load events because the HTML is dynamically injected; run code directly in the `<script>`.
       CRITICAL TELEMETRY: The frontend exposes a global function `window.sendEventToAI(textString)`. You MUST call this function whenever the user meaningfully interacts with a UI control (e.g., inside slider `onchange` or button `onclick` handlers). Pass it a detailed string describing the logical action AND the exact *visual* consequences on the screen.
    6. TEXT WRAPPING & OVERFLOW FIX: SVG `<text>` elements do *not* auto-wrap and easily bleed out of cards! To prevent text from overflowing or exceeding the margins/borders of cards (like long emails or permissions text), you MUST use `<foreignObject>` with explicitly defined `width` and `height` slightly smaller than its parent container/card. The inner `<div xmlns="http://www.w3.org/1999/xhtml">` must use CSS `width: 100%; height: 100%; overflow: hidden; text-overflow: ellipsis; word-wrap: break-word; box-sizing: border-box; padding: 4px;` and properly sized fonts so text absolutely never spills out.
    7. NARRATION: Write a concise 1-paragraph summary wrapped in `<narration>...</narration>` tags explaining the UI controls and visually describing the diagram.
    8. NO TEXT OVERLAY ON SVG: The `<svg-panel>` must contain ONLY the visual diagram/animation — NO explanatory text, titles, descriptions, or long labels that overlay or cover the graphic. All textual explanations, descriptions, step-by-step instructions, and informational text MUST go in the `<controls-panel>` on the right. The SVG should be a clean, unobstructed visual. Short labels (1-3 words) on diagram elements are OK, but paragraphs of text are NOT. This is critical — the user needs to see the animation clearly.
    9. LABEL READABILITY: All short text labels in the SVG MUST be clearly legible and never obscured by other elements. To achieve this:
       - Place ALL `<text>` label elements LAST in the SVG markup so they render on top of everything else (SVG uses painter's model — later elements are drawn on top).
       - Add a semi-transparent white or dark background behind each label using a `<rect>` with `rx="4"` and `fill="rgba(255,255,255,0.85)"` (or dark equivalent) placed immediately before the `<text>` element, sized to fit the text.
       - Use `font-weight="bold"` and a legible font size (14px+) for all labels.
       - Position labels in clear space away from overlapping shapes. Never place a label where a shape, path, or animation will cover it.

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

        
    # FORCE CLEAN: Remove literal backslash escapes for quotes just in case the model hallucinates them
    svg_html = svg_html.replace('\\"', '"').replace("\\'", "'")
    controls_html = controls_html.replace('\\"', '"').replace("\\'", "'")
    
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
    await _run_live_session(websocket, narration_context, source_labels, svg_html)


async def handle_live_restart(websocket: WebSocket, narration_context: str, source_labels: list[str]):
    """
    Restart a live conversation on an existing graphic.
    Skips graphic generation and goes straight to the Live API.
    """
    print(f"[Live Restart] Starting with {len(source_labels)} source label(s)")
    await _run_live_session(websocket, narration_context, source_labels, "")


async def _run_live_session(websocket: WebSocket, narration_context: str, source_labels: list[str], svg_html: str):
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
    
    YOUR BEHAVIOR:
    1. Welcome the user warmly. Give a 2-3 sentence summary of what the graphic shows.
    2. Then invite the user to explore: "What part would you like to dive into?"
    3. When the user asks about a concept, explain it clearly. Use `highlight_element` to point out the relevant part if helpful.
    4. Use `navigate_to_section` only when moving between distinctly different areas of the diagram.
    5. Use `zoom_view` sparingly — only if the user asks to see details up close.
    6. If the user asks about something not in the diagram, use `fetch_more_detail` to search for it.
    7. If the user asks you to CHANGE the graphic (e.g., "make it red", "hide the clouds", "make the sun bigger"), use `modify_element` to update the CSS in real-time.
    8. If the user asks you to interact with UI controls (e.g., "stop the autoplay", "click Evaporation", "press Play"), use `click_element` to click that button.
    9. Keep responses concise and conversational. You're a tutor, not a lecturer.
    
    TOOL TIPS:
    - Call ONE tool at a time, not multiple simultaneously.
    - Always speak while or after using a tool — never go silent after a tool call.
    - The element_id for tools should match labels or keywords visible in the diagram.
    - For modify_element, use SVG attributes like 'fill', 'opacity', 'transform', or CSS properties like 'display', 'font-size'.
    - For click_element, match the exact button text shown on screen (e.g., 'Play Auto-Cycle', 'Evaporation', 'Reset').
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
    
    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=types.Content(parts=[types.Part.from_text(text=system_instruction)]),
        tools=agent_tools
    )
    
    
    # WebSocket collision lock to prevent Starlette RuntimeError
    ws_lock = asyncio.Lock()
    
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
    # 3. Phase 2: Live Presenter (Connect to Gemini Live API)
    # --------------------------------------------------------------------------------
    print("[Gemini] Attempting to connect to Live API...")
    async with client.aio.live.connect(model=model, config=config) as session:
        print("[Gemini] Connected to Live API")
        
        # Immediately flush any pre-presentation interaction events to the AI
        for event_text in initial_events:
            print(f"[Gemini] Sending queued pre-presentation event: {event_text}")
            try:
                await session.send_client_content(
                    turns=[types.Content(parts=[types.Part.from_text(text=event_text)])]
                )
            except Exception as e:
                 print(f"[Gemini] Error sending queued event: {e}")
                 
        async with ws_lock:
            await websocket.send_json({"type": "ready"})
        
        # Kick off the conversation — send a prompt so the AI starts talking immediately
        try:
            await session.send_client_content(
                turns=[types.Content(parts=[types.Part.from_text(
                    text="The user just joined the session. Begin your welcome and overview now."
                )])]
            )
        except Exception as e:
            print(f"[Gemini] Error sending initial prompt: {e}")
        
        async def receive_from_client_and_send_to_gemini():
            try:
                while True:
                    data = await websocket.receive_text()
                    payload = json.loads(data)
                    
                    if "realtimeInput" in payload:
                        chunk = payload["realtimeInput"]["mediaChunks"][0]
                        b64_data = chunk["data"]
                        mime_type = chunk["mimeType"]
                        raw_bytes = base64.b64decode(b64_data)
                        
                        try:
                            await session.send_realtime_input(
                                media=types.Blob(mime_type=mime_type, data=raw_bytes)
                            )
                        except Exception as inner_e:
                            err_str = str(inner_e)
                            if "1011" in err_str:
                                print(f"[Receive Task] Gemini session died (1011). Stopping audio send.")
                                return
                            print(f"[Receive Task] Error sending audio to Gemini: {inner_e}")
                    elif "clientContent" in payload:
                        try:
                            text = payload["clientContent"]["turns"][0]["parts"][0]["text"]
                            await session.send_client_content(
                                turns=[types.Content(parts=[types.Part.from_text(text=text)])]
                            )
                        except Exception as inner_e:
                            print(f"[Receive Task] Error sending text to Gemini: {inner_e}")
            
            except WebSocketDisconnect:
                print("[Receive Task] Client WebSocket Disconnected normally.")
            except Exception as e:
                print(f"[Receive Task] Error/Disconnected: {type(e).__name__} - {e}")

        async def receive_from_gemini_and_send_to_client():
            interrupted = False
            error_1011_count = 0
            while True:
                try:
                    async for response in session.receive():
                        server_content = response.server_content
                        if server_content:
                            if getattr(server_content, "interrupted", False):
                                print("[Gemini] User Interruption Detected! Halting queue...")
                                interrupted = True
                                async with ws_lock:
                                    await websocket.send_json({"type": "clear"})
                                # Don't break — continue processing to drain any pending responses
                                continue
                                    
                        if server_content and server_content.model_turn:
                            interrupted = False  # Model is actively responding, clear interrupt flag
                            error_1011_count = 0  # Reset error counter on successful response
                            for part in server_content.model_turn.parts:
                                if part.inline_data:
                                    # Gemini Native Audio response - stream to frontend
                                    audio_base64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                    async with ws_lock:
                                        await websocket.send_json({
                                            "type": "audio",
                                            "mimeType": part.inline_data.mime_type,
                                            "data": audio_base64
                                        })
                        
                        # Handle Tool Calls
                        if response.tool_call:
                            if interrupted:
                                # Skip tool responses if the user interrupted — Gemini doesn't expect them
                                print(f"[Tool Call] Skipping {len(response.tool_call.function_calls)} tool call(s) due to interruption")
                                interrupted = False
                                continue
                            
                            func_responses = []
                            for func_call in response.tool_call.function_calls:
                                tool_name = func_call.name
                                tool_args = dict(func_call.args) if func_call.args else {}
                                print(f"[Tool Call] {tool_name}({tool_args})")
                                
                                if tool_name in ("highlight_element", "navigate_to_section", "zoom_view", "modify_element", "click_element"):
                                    # Forward visual action to frontend
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
                                    # Send status to frontend
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
                                    # Legacy tool — re-send existing graphic
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
                    print("[Gemini Task] Client WebSocket Disconnected normally. Ending Gemini session.")
                    break
                except asyncio.CancelledError:
                    print("[Gemini Task] Task cancelled. Ending Gemini session.")
                    break
                except Exception as e:
                    print(f"[Gemini Task] Error/Disconnected: {type(e).__name__} - {e}")
                    break

        # Run both loops concurrently. If either fails, we kill the other
        receive_task = asyncio.create_task(receive_from_client_and_send_to_gemini())
        gemini_task = asyncio.create_task(receive_from_gemini_and_send_to_client())
        
        done, pending = await asyncio.wait(
            [receive_task, gemini_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        print("[Live Session] Complete/Terminated.")
