import sys

with open('src/App.tsx', 'r') as f:
    lines = f.readlines()

new_content = """  // Listen for telemetry events from the generated graphic iframe
  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      if (event.data?.type === 'AI_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Graphic Event: ${event.data.payload}]` }] }],
              turnComplete: false
            }
          }))
        }
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, []);

  // Construct a secure, isolated HTML document for the graphic and controls
  const iframeSrcDoc = useMemo(() => {
    if (!currentSvg) return '';
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: transparent;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    .layout-container {
      display: flex;
      width: 100%;
      height: 100%;
    }
    .svg-area {
      flex: 1;
      padding: 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      position: relative;
      min-height: 0;
      min-width: 0;
    }
    .controls-area {
      flex: 0.4;
      min-width: 420px;
      max-width: 500px;
      height: 100%;
      padding: 24px;
      box-sizing: border-box;
      overflow-y: auto;
      transition: all 0.3s ease-in-out;
      border-left: 1px solid rgba(0,0,0,0.05);
    }
    body.sidebar-open .controls-area {
      flex: none;
      width: 380px;
      min-width: 380px;
      max-width: 380px;
    }
  </style>
  <script>
    window.sendEventToAI = function(message) {
      window.parent.postMessage({ type: 'AI_EVENT', payload: message }, '*');
    };
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'SIDEBAR_TOGGLE') {
        if (event.data.isOpen) {
          document.body.classList.add('sidebar-open');
        } else {
          document.body.classList.remove('sidebar-open');
        }
      }
    });
  </script>
</head>
<body class="${isSidebarOpen ? 'sidebar-open' : ''}">
  <div class="layout-container">
    <div class="svg-area">
      ${(currentTitle || currentSubtitle) ? `
        <div style="margin-bottom: 24px; width: 100%; flex-shrink: 0;">
          ${currentTitle ? `<h2 style="font-size: 30px; font-weight: 700; color: #1e293b; margin: 0 0 8px 0; letter-spacing: -0.025em;">${currentTitle}</h2>` : ''}
          ${currentSubtitle ? `<p style="font-size: 18px; color: #64748b; margin: 0;">${currentSubtitle}</p>` : ''}
        </div>
      ` : ''}
      <div style="flex: 1; width: 100%; display: flex; align-items: center; justify-content: center; min-height: 0;">
        ${currentSvg}
      </div>
    </div>
    ${currentControls ? `
    <div class="controls-area">
      ${currentControls}
    </div>
    ` : ''}
  </div>
</body>
</html>
    `;
  }, [currentSvg, currentControls, currentTitle, currentSubtitle]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'SIDEBAR_TOGGLE', isOpen: isSidebarOpen }, '*');
    }
  }, [isSidebarOpen]);
"""

# Find borders
start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if '// Execute injected scripts whenever SVG or controls update' in line:
        start_idx = i
    if start_idx != -1 and '}, [currentSvg, currentControls]);' in line:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    lines[start_idx:end_idx+1] = [new_content + '\n']
    with open('src/App.tsx', 'w') as f:
        f.writelines(lines)
    print("Patched App.tsx!")
else:
    print("Could not find boundaries")

