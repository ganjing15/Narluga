# Security Implementation

## Overview
Lightweight security measures implemented to protect against malicious content in AI-generated graphics.

## Threat Model
- Users generate their own graphics using Gemini AI
- Admin curates example graphics for all users
- No user-to-user graphic sharing (low risk scenario)

## Security Measures Implemented

### 1. SVG Sanitization
**Location**: `frontend/src/App.tsx` - `sanitizeSvg()` function

**Protects Against**:
- XSS via `<script>` tags in SVG
- Event handler injection (`onclick`, `onload`, etc.)
- JavaScript URLs (`javascript:alert()`)
- Data URLs that could contain scripts

**Implementation**:
- Strips all `<script>` tags
- Removes event handler attributes
- Removes `javascript:` protocol URLs
- Removes `data:` URLs from href/src attributes

### 2. Controls HTML Sanitization
**Location**: `frontend/src/App.tsx` - `sanitizeControls()` function

**Protects Against**:
- JavaScript URLs

**Implementation**:
- Removes `javascript:` protocol URLs only
- **Allows** `<script>` tags (required for interactive functions)
- **Allows** `onclick`/`oninput` handlers (required for interactivity)

**Why Scripts Are Allowed**:
- Essential for interactive functions (togglePlay, updateState, etc.)
- CSP prevents malicious scripts from making network requests or accessing parent
- Users only see their own graphics (no cross-user attacks)
- AI-generated code must run for graphics to work

### 3. CSS Property Whitelist
**Location**: `frontend/src/App.tsx` - `modify_element` tool handler

**Protects Against**:
- CSS injection attacks
- UI overlay attacks (position: fixed)
- External resource loading (url())
- CSS expression attacks

**Whitelisted Properties**:
- Visual: fill, stroke, opacity, color, background-color
- Layout: width, height, display
- Transform: scale, transform
- Effects: filter
- Typography: font-size, font-weight
- SVG: stroke-width, r, cx, cy, x, y

**Blocked Values**:
- `javascript:` URLs
- `data:` URLs
- `<script` tags
- `expression()` (IE legacy)
- `import` statements
- `url()` (external resources)

### 4. Content Security Policy
**Location**: `frontend/src/App.tsx` - iframe `<head>` meta tag

**Policy**:
```
default-src 'none'; 
script-src 'unsafe-inline'; 
style-src 'unsafe-inline'; 
img-src data: blob:;
```

**Protects Against**:
- Loading external scripts
- Loading external stylesheets
- Loading external images (except data/blob)
- Network requests from iframe

**Note**: `'unsafe-inline'` is required for AI-generated inline scripts/styles to work.

## What's NOT Protected

### Still Vulnerable To:
1. **Social Engineering** - Graphics can display misleading text/visuals
2. **Phishing Content** - Text saying "Enter your password" (but can't steal it)
3. **Resource Exhaustion** - Infinite loops in animations
4. **Visual Deception** - Graphics designed to look like system dialogs

### Why These Are Acceptable:
- Users only see their own graphics + admin-curated examples
- Admin reviews curated graphics before publishing
- Gemini AI has built-in safety filters
- No user-to-user sharing means no attack vector

## Future Enhancements (If User-to-User Sharing Added)

### Critical Upgrades Needed:
1. **Origin Separation** - Serve iframes from separate subdomain
2. **Remove allow-same-origin** - Prevent iframe from accessing parent cookies
3. **Server-side Sanitization** - Sanitize before saving to Firestore
4. **Content Moderation** - Review system for user-generated graphics
5. **Rate Limiting** - Prevent abuse of generation API

### Architecture Change:
```typescript
// Current (same-origin)
sandbox="allow-scripts allow-same-origin"

// Future (cross-origin)
sandbox="allow-scripts"
// Serve from graphics.yourdomain.com
```

## Testing Security

### Manual Tests:
1. Try generating graphic with `<script>alert('xss')</script>` in prompt
2. Try modifying element with `position: fixed` CSS
3. Try modifying element with `url(http://evil.com)` CSS
4. Check browser console for blocked CSP violations

### Expected Behavior:
- Scripts should be stripped from SVG
- Dangerous CSS properties should be blocked with console warning
- CSP should prevent external resource loading
- Graphics should still work normally for legitimate use

## Maintenance

### When to Update:
- If adding user-to-user sharing → Implement full hardening
- If new XSS vectors discovered → Update sanitization regexes
- If new CSS attack vectors → Update whitelist/blocklist
- If CSP too restrictive → Adjust policy carefully

### Monitoring:
- Watch browser console for CSP violations
- Monitor for unusual graphic generation patterns
- Review curated graphics before publishing
