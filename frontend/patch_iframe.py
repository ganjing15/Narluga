import sys

with open('src/App.tsx', 'r') as f:
    content = f.read()

# 1. Update the iframe source doc script to include tools and hover tracking
new_script = """
  <script>
    // Communication bridge to host React app
    window.sendEventToAI = function(message) {
      window.parent.postMessage({ type: 'AI_EVENT', payload: message }, '*');
    };

    // Listen for layout changes and tool actions from host
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'SIDEBAR_TOGGLE') {
        if (event.data.isOpen) {
          document.body.classList.add('sidebar-open');
        } else {
          document.body.classList.remove('sidebar-open');
        }
      } else if (event.data?.type === 'TOOL_ACTION') {
        handleToolAction(event.data.action, event.data.params);
      }
    });

    // --- TOOL ACTIONS (Highlighting, Zooming) ---
    function handleToolAction(action, params) {
      const svgContainer = document.querySelector('.svg-area');
      if (!svgContainer) return;

      const findElements = (keyword) => {
        const kw = keyword.toLowerCase().replace(/[-_]/g, ' ').trim();
        if (!kw) return [];
        const results = [];
        const containerRect = svgContainer.getBoundingClientRect();

        const isTooLarge = (el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > containerRect.width * 0.6 && rect.height > containerRect.height * 0.6;
        };

        svgContainer.querySelectorAll('[id], [data-label], [data-section]').forEach(el => {
          const id = (el.id || '').toLowerCase().replace(/[-_]/g, ' ');
          const label = (el.getAttribute('data-label') || '').toLowerCase();
          const section = (el.getAttribute('data-section') || '').toLowerCase();
          if ((id.length >= 3 && id.includes(kw)) || label.includes(kw) || section.includes(kw)) {
            if (!isTooLarge(el)) results.push(el);
          }
        });

        if (results.length === 0) {
          svgContainer.querySelectorAll('text, tspan, foreignObject, h1, h2, h3, h4, p, span, label, button').forEach(el => {
            const text = (el.textContent || '').toLowerCase().trim();
            if (text.length > 0 && text.length < 200 && (text.includes(kw) || kw.split(' ').every(w => text.includes(w)))) {
              let target = el;
              if (el instanceof SVGElement && el.parentElement && el.parentElement.tagName.toLowerCase() === 'g') {
                target = el.parentElement;
              }
              if (!isTooLarge(target) && !results.includes(target)) results.push(target);
            }
          });
        }

        results.sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return (aRect.width * aRect.height) - (bRect.width * bRect.height);
        });

        return results.slice(0, 3);
      };

      if (action === 'highlight_element') {
        const elements = findElements(params.element_id || '');
        const color = params.color || '#3b82f6';
        elements.forEach(el => {
          const prev = el.style.cssText;
          el.style.transition = 'all 0.4s ease';
          el.style.filter = `drop-shadow(0 0 16px ${color}) drop-shadow(0 0 8px ${color})`;
          if (el instanceof SVGElement) {
            el.style.transform = 'scale(1.03)';
            el.style.transformOrigin = 'center';
          }
          setTimeout(() => {
            el.style.filter = '';
            el.style.transform = '';
            setTimeout(() => { el.style.cssText = prev; }, 400);
          }, 4000);
        });
        if (elements.length > 0) elements[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } else if (action === 'navigate_to_section') {
        const elements = findElements(params.section || '');
        if (elements.length > 0) elements[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } else if (action === 'zoom_view') {
        const dir = params.direction || 'in';
        const currentScale = parseFloat(svgContainer.dataset.zoomScale || '1');
        let newScale = dir === 'in' ? Math.min(currentScale * 1.4, 3) : Math.max(currentScale / 1.4, 0.5);
        svgContainer.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
        svgContainer.style.transform = `scale(${newScale})`;
        svgContainer.dataset.zoomScale = newScale.toString();
      } else if (action === 'fetch_more_detail') {
        const elements = findElements(params.topic || '');
        elements.forEach(el => {
          const prev = el.style.cssText;
          el.style.transition = 'all 0.3s ease';
          el.style.filter = 'drop-shadow(0 0 12px #fbbf24)';
          setTimeout(() => { el.style.cssText = prev; }, 2000);
        });
      }
    }

    // --- HOVER TRACKING ---
    let debounceTimer = null;
    let lastReport = '';

    document.addEventListener('mousemove', (e) => {
      const svgContainer = document.querySelector('.svg-area');
      if (!svgContainer) return;
      
      const target = e.target;
      if (!svgContainer.contains(target)) return;

      const directLabel = target.getAttribute('data-label') || target.getAttribute('id') || '';
      let nearestLabel = '';
      let nearestDist = 60; 
      
      svgContainer.querySelectorAll('text').forEach(textEl => {
        const content = (textEl.textContent || '').trim();
        if (content.length < 2 || content.length > 60) return;
        const rect = textEl.getBoundingClientRect();
        const textCx = rect.left + rect.width / 2;
        const textCy = rect.top + rect.height / 2;
        const dist = Math.sqrt((e.clientX - textCx) ** 2 + (e.clientY - textCy) ** 2);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestLabel = content;
        }
      });

      const tagName = target.tagName.toLowerCase();
      const fill = target.getAttribute('fill') || '';
      let elementDesc = '';
      if (['rect', 'circle', 'ellipse', 'polygon', 'path', 'line'].includes(tagName)) {
        elementDesc = `a ${fill ? fill + ' ' : ''}${tagName} shape`;
      }

      let report = '';
      if (directLabel && directLabel.length >= 2) {
        report = `"${directLabel}"`;
      } else if (nearestLabel) {
        report = `near the "${nearestLabel}" label`;
        if (elementDesc) report += ` (on ${elementDesc})`;
      } else if (elementDesc) {
        report = elementDesc;
      }

      if (!report || report === lastReport) return;
      lastReport = report;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        window.parent.postMessage({ type: 'HOVER_EVENT', payload: report }, '*');
      }, 1500);
    });
  </script>
"""

import re

# Replace the inner script in iframeSrcDoc
content = re.sub(
    r'<script>\s*window\.sendEventToAI.*?</script>',
    new_script,
    content,
    flags=re.DOTALL
)

# 2. Modify App.tsx to forward TOOL_ACTION to iframe and listen for HOVER_EVENT
# Replace old tool logic in the websocket data handler
old_tool_logic = """        } else if (data.type === 'tool_action') {
          const { action, params } = data
          const svgContainer = document.querySelector('[data-svg-container]') as HTMLElement
          if (!svgContainer) return

          // Helper: find SVG elements by fuzzy text/ID match"""

new_tool_logic = """        } else if (data.type === 'tool_action') {
          const { action, params } = data
          if (iframeRef.current && iframeRef.current.contentWindow) {
            iframeRef.current.contentWindow.postMessage({ type: 'TOOL_ACTION', action, params }, '*');
          }
          // The rest of the legacy tool execution is removed as it's now in the iframe"""

if old_tool_logic in content:
    # Need to cut out everything until the end of the `fetch_more_detail` block
    start_idx = content.find(old_tool_logic)
    end_marker = "            })\n          }\n        }\n      }\n    }\n"
    end_idx = content.find(end_marker, start_idx)
    
    if end_idx != -1:
        # Re-attach the closing braces properly
        content = content[:start_idx] + new_tool_logic + "\n        }\n      }\n    }\n" + content[end_idx + len(end_marker):]

# 3. Replace old mousemove logic
old_mouse_logic = """  // Setup mouse tracking over the SVG for context grounding
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let lastReport = ''

    const handleMouseMove = (e: MouseEvent) => {"""

new_mouse_logic = """  // Setup mouse tracking (now handled by iframe postMessage)
  /* Legacy local mouse tracking removed */
  useEffect(() => {
    // Keep empty dependency logic if needed, but we listen for HOVER_EVENT globally now
  }, [sessionPhase, currentSvg])
"""

if old_mouse_logic in content:
    start_idx = content.find(old_mouse_logic)
    end_marker = "  }, [sessionPhase, currentSvg])\n"
    end_idx = content.find(end_marker, start_idx) + len(end_marker)
    content = content[:start_idx] + new_mouse_logic + content[end_idx:]


# 4. Add HOVER_EVENT receiver to the existing window message listener
hover_listener = """      if (event.data?.type === 'AI_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Graphic Event: ${event.data.payload}]` }] }],
              turnComplete: false
            }
          }))
        }
      }"""

new_hover_listener = """      if (event.data?.type === 'AI_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Graphic Event: ${event.data.payload}]` }] }],
              turnComplete: false
            }
          }))
        }
      } else if (event.data?.type === 'HOVER_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && hasStartedRef.current) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Cursor position: The user is currently pointing at ${event.data.payload} in the diagram.]` }] }],
              turnComplete: false
            }
          }))
        }
      }"""

content = content.replace(hover_listener, new_hover_listener)

with open('src/App.tsx', 'w') as f:
    f.write(content)

print("Patch complete")
