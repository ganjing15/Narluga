// Curated example graphics for the homepage
// Each example contains pre-generated SVG + controls HTML that loads instantly

export interface CuratedExample {
    id: string
    title: string
    emoji: string
    description: string
    svg_html: string
    controls_html: string
    narration_context: string
    source_labels: string[]
}

export const CURATED_EXAMPLES: CuratedExample[] = [
    {
        id: 'earths-seasons',
        title: "Earth's Seasons",
        emoji: '🌍',
        description: 'Why do seasons change as Earth orbits the Sun?',
        svg_html: `
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-height:90vh">
  <defs>
    <radialGradient id="sunGrad" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#f59e0b"/></radialGradient>
    <radialGradient id="earthGrad" cx="40%" cy="35%" r="50%"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#1d4ed8"/></radialGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="800" height="500" fill="#0f172a" rx="16"/>
  <!-- Stars -->
  <g opacity="0.4"><circle cx="50" cy="30" r="1.5" fill="white"/><circle cx="150" cy="80" r="1" fill="white"/><circle cx="700" cy="60" r="1.5" fill="white"/><circle cx="600" cy="420" r="1" fill="white"/><circle cx="100" cy="400" r="1.2" fill="white"/><circle cx="750" cy="200" r="1" fill="white"/><circle cx="300" cy="30" r="1.3" fill="white"/><circle cx="500" cy="470" r="1" fill="white"/></g>
  <!-- Orbit path -->
  <g id="orbit-group">
    <ellipse cx="400" cy="250" rx="280" ry="160" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="8 6"/>
  </g>
  <!-- Sun -->
  <g id="sun" filter="url(#glow)">
    <circle cx="400" cy="250" r="50" fill="url(#sunGrad)"/>
    <circle cx="400" cy="250" r="65" fill="none" stroke="rgba(251,191,36,0.2)" stroke-width="2"/>
  </g>
  <text x="400" y="325" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="13" font-family="system-ui">Sun</text>
  <!-- Earth positions -->
  <g id="earth-summer" transform="translate(680, 250)">
    <line x1="0" y1="-30" x2="0" y2="30" stroke="rgba(255,255,255,0.3)" stroke-width="1" transform="rotate(-23.5)"/>
    <circle r="22" fill="url(#earthGrad)" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
    <ellipse rx="22" ry="6" fill="none" stroke="rgba(34,197,94,0.4)" stroke-width="1.5"/>
  </g>
  <text x="680" y="292" text-anchor="middle" fill="#22c55e" font-size="12" font-weight="600" font-family="system-ui">Jun — Summer</text>
  <g id="earth-winter" transform="translate(120, 250)">
    <line x1="0" y1="-30" x2="0" y2="30" stroke="rgba(255,255,255,0.3)" stroke-width="1" transform="rotate(-23.5)"/>
    <circle r="22" fill="url(#earthGrad)" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
    <ellipse rx="22" ry="6" fill="none" stroke="rgba(34,197,94,0.4)" stroke-width="1.5"/>
  </g>
  <text x="120" y="292" text-anchor="middle" fill="#93c5fd" font-size="12" font-weight="600" font-family="system-ui">Dec — Winter</text>
  <g id="earth-spring" transform="translate(400, 90)">
    <line x1="0" y1="-30" x2="0" y2="30" stroke="rgba(255,255,255,0.3)" stroke-width="1" transform="rotate(-23.5)"/>
    <circle r="18" fill="url(#earthGrad)" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
  </g>
  <text x="400" y="65" text-anchor="middle" fill="#a78bfa" font-size="12" font-weight="600" font-family="system-ui">Mar — Spring</text>
  <g id="earth-autumn" transform="translate(400, 410)">
    <line x1="0" y1="-30" x2="0" y2="30" stroke="rgba(255,255,255,0.3)" stroke-width="1" transform="rotate(-23.5)"/>
    <circle r="18" fill="url(#earthGrad)" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
  </g>
  <text x="400" y="445" text-anchor="middle" fill="#fb923c" font-size="12" font-weight="600" font-family="system-ui">Sep — Autumn</text>
  <!-- Axial tilt label -->
  <text x="720" y="30" text-anchor="end" fill="rgba(255,255,255,0.5)" font-size="11" font-family="system-ui">23.5° axial tilt</text>
  <!-- Title -->
  <text x="400" y="490" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="11" font-family="system-ui">Northern Hemisphere seasons shown</text>
</svg>`,
        controls_html: `
<div id="controls-panel" style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">Earth's Seasons</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;line-height:1.5;">Earth's 23.5° axial tilt causes seasons as it orbits the Sun. When the Northern Hemisphere tilts toward the Sun, it receives more direct sunlight — creating summer.</p>
  <div id="info-panel" style="padding:16px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <div id="info-title" style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">Key Concept</div>
    <div id="info-desc" style="font-size:13px;color:#475569;line-height:1.5;">Seasons are NOT caused by distance from the Sun. Earth's distance varies only ~3% throughout the year. Instead, the angle of sunlight hitting the surface determines temperature.</div>
  </div>
</div>`,
        narration_context: "This diagram shows Earth's orbit around the Sun with its 23.5-degree axial tilt. Four positions are marked: June (summer), December (winter), March (spring), and September (autumn) for the Northern Hemisphere. The tilt causes different amounts of direct sunlight at different times of year.",
        source_labels: ['Earth Seasons — NASA']
    },
    {
        id: 'solar-system',
        title: 'Solar System',
        emoji: '☀️',
        description: 'Explore the planets and their orbits around the Sun.',
        svg_html: `
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-height:90vh">
  <defs>
    <radialGradient id="ssunG" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fde68a"/><stop offset="80%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#d97706"/></radialGradient>
    <filter id="sglow"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="800" height="500" fill="#020617" rx="16"/>
  <g opacity="0.3"><circle cx="60" cy="40" r="1" fill="white"/><circle cx="200" cy="90" r="0.8" fill="white"/><circle cx="740" cy="70" r="1.2" fill="white"/><circle cx="650" cy="440" r="0.8" fill="white"/><circle cx="90" cy="380" r="1" fill="white"/><circle cx="500" cy="30" r="1" fill="white"/></g>
  <!-- Sun -->
  <g id="sun" filter="url(#sglow)"><circle cx="80" cy="250" r="40" fill="url(#ssunG)"/></g>
  <text x="80" y="305" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="11" font-family="system-ui">Sun</text>
  <!-- Orbits -->
  <circle cx="80" cy="250" r="75" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="110" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="150" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="200" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="300" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="380" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="490" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <circle cx="80" cy="250" r="580" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <!-- Planets -->
  <g id="mercury"><circle cx="155" cy="240" r="4" fill="#94a3b8"/><text x="155" y="225" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="9" font-family="system-ui">Mercury</text></g>
  <g id="venus"><circle cx="175" cy="160" r="6" fill="#fbbf24"/><text x="175" y="145" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="9" font-family="system-ui">Venus</text></g>
  <g id="earth"><circle cx="230" cy="280" r="7" fill="#3b82f6"/><circle cx="238" cy="276" r="2" fill="#94a3b8"/><text x="230" y="300" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="9" font-family="system-ui">Earth</text></g>
  <g id="mars"><circle cx="250" cy="130" r="5" fill="#ef4444"/><text x="250" y="118" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="9" font-family="system-ui">Mars</text></g>
  <g id="jupiter"><circle cx="350" cy="370" r="18" fill="#c2884d" stroke="#a87a44" stroke-width="1"/><ellipse cx="350" cy="367" rx="16" ry="3" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"/><text x="350" y="400" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-family="system-ui">Jupiter</text></g>
  <g id="saturn"><circle cx="430" cy="140" r="14" fill="#e5c07b"/><ellipse cx="430" cy="140" rx="24" ry="5" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"/><text x="430" y="170" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-family="system-ui">Saturn</text></g>
  <g id="uranus"><circle cx="540" cy="340" r="10" fill="#67e8f9"/><text x="540" y="365" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-family="system-ui">Uranus</text></g>
  <g id="neptune"><circle cx="640" cy="170" r="9" fill="#6366f1"/><text x="640" y="195" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-family="system-ui">Neptune</text></g>
</svg>`,
        controls_html: `
<div id="controls-panel" style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">The Solar System</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;line-height:1.5;">Our solar system has 8 planets orbiting the Sun. The inner rocky planets (Mercury–Mars) are much smaller than the outer gas and ice giants (Jupiter–Neptune).</p>
  <div id="info-panel" style="padding:16px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <div id="info-title" style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">Scale</div>
    <div id="info-desc" style="font-size:13px;color:#475569;line-height:1.5;">Jupiter alone is more massive than all other planets combined. It could fit 1,300 Earths inside it. The Sun contains 99.86% of all mass in the solar system.</div>
  </div>
</div>`,
        narration_context: "This diagram shows the solar system with the Sun and all 8 planets in their orbital positions. Mercury, Venus, Earth, and Mars are the inner rocky planets, while Jupiter, Saturn, Uranus, and Neptune are the outer giants.",
        source_labels: ['Solar System — NASA']
    },
    {
        id: 'dna-replication',
        title: 'DNA Replication',
        emoji: '🧬',
        description: 'How DNA copies itself during cell division.',
        svg_html: `
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-height:90vh">
  <defs>
    <linearGradient id="dnaStrand1" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#818cf8"/></linearGradient>
    <linearGradient id="dnaStrand2" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#f472b6"/></linearGradient>
  </defs>
  <rect width="800" height="500" fill="#fefce8" rx="16"/>
  <!-- Replication fork label -->
  <text x="400" y="30" text-anchor="middle" fill="#0f172a" font-size="16" font-weight="700" font-family="system-ui">DNA Replication Fork</text>
  <!-- Original double strand (left) -->
  <g id="original-dna">
    <path d="M 50 100 Q 120 140, 120 180 Q 120 220, 50 260 Q -20 300, -20 340 Q -20 380, 50 420" fill="none" stroke="url(#dnaStrand1)" stroke-width="4" transform="translate(80,0)"/>
    <path d="M 90 100 Q 20 140, 20 180 Q 20 220, 90 260 Q 160 300, 160 340 Q 160 380, 90 420" fill="none" stroke="url(#dnaStrand2)" stroke-width="4" transform="translate(80,0)"/>
    <!-- Base pairs -->
    <g stroke="#94a3b8" stroke-width="2">
      <line x1="130" y1="130" x2="170" y2="150" /><line x1="110" y1="180" x2="190" y2="180" /><line x1="110" y1="220" x2="190" y2="220" /><line x1="130" y1="270" x2="170" y2="250" /><line x1="90" y1="310" x2="210" y2="310" /><line x1="100" y1="350" x2="200" y2="350" /><line x1="130" y1="390" x2="170" y2="410" />
    </g>
    <!-- Base pair colors -->
    <circle cx="130" cy="130" r="5" fill="#ef4444"/><circle cx="170" cy="150" r="5" fill="#22c55e"/>
    <circle cx="110" cy="180" r="5" fill="#3b82f6"/><circle cx="190" cy="180" r="5" fill="#f59e0b"/>
    <circle cx="110" cy="220" r="5" fill="#f59e0b"/><circle cx="190" cy="220" r="5" fill="#3b82f6"/>
    <circle cx="130" cy="270" r="5" fill="#22c55e"/><circle cx="170" cy="250" r="5" fill="#ef4444"/>
  </g>
  <text x="150" y="460" text-anchor="middle" fill="#475569" font-size="12" font-weight="600" font-family="system-ui">Parent DNA</text>
  <!-- Replication fork (center) -->
  <g id="fork">
    <path d="M 300 200 L 400 250 L 300 300" fill="none" stroke="#0f172a" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="370" y="240" fill="#0f172a" font-size="11" font-weight="600" font-family="system-ui">Fork</text>
    <!-- Helicase -->
    <circle cx="400" cy="250" r="20" fill="#fbbf24" stroke="#f59e0b" stroke-width="2"/>
    <text x="400" y="254" text-anchor="middle" fill="#0f172a" font-size="9" font-weight="700" font-family="system-ui">Helicase</text>
  </g>
  <!-- Leading strand (top right) -->
  <g id="leading-strand">
    <path d="M 420 230 Q 500 180, 580 160 Q 660 140, 740 120" fill="none" stroke="url(#dnaStrand1)" stroke-width="4"/>
    <path d="M 420 230 Q 500 200, 580 190 Q 660 180, 740 170" fill="none" stroke="#22c55e" stroke-width="3" stroke-dasharray="12 4"/>
    <text x="600" y="110" fill="#6366f1" font-size="11" font-weight="600" font-family="system-ui">Leading Strand</text>
    <text x="630" y="200" fill="#22c55e" font-size="11" font-weight="600" font-family="system-ui">→ 3' to 5'</text>
  </g>
  <!-- Lagging strand (bottom right) -->
  <g id="lagging-strand">
    <path d="M 420 270 Q 500 320, 580 340 Q 660 360, 740 380" fill="none" stroke="url(#dnaStrand2)" stroke-width="4"/>
    <path d="M 470 290 Q 510 310, 550 320" fill="none" stroke="#3b82f6" stroke-width="3"/>
    <path d="M 570 330 Q 610 345, 650 350" fill="none" stroke="#3b82f6" stroke-width="3"/>
    <path d="M 670 360 Q 700 368, 730 375" fill="none" stroke="#3b82f6" stroke-width="3"/>
    <text x="600" y="412" fill="#ec4899" font-size="11" font-weight="600" font-family="system-ui">Lagging Strand</text>
    <text x="550" y="360" fill="#3b82f6" font-size="10" font-family="system-ui">Okazaki fragments</text>
  </g>
  <!-- Legend -->
  <g transform="translate(580, 440)">
    <circle cx="0" cy="0" r="5" fill="#ef4444"/><text x="10" y="4" fill="#475569" font-size="10" font-family="system-ui">A</text>
    <circle cx="40" cy="0" r="5" fill="#22c55e"/><text x="50" y="4" fill="#475569" font-size="10" font-family="system-ui">T</text>
    <circle cx="80" cy="0" r="5" fill="#3b82f6"/><text x="90" y="4" fill="#475569" font-size="10" font-family="system-ui">C</text>
    <circle cx="120" cy="0" r="5" fill="#f59e0b"/><text x="130" y="4" fill="#475569" font-size="10" font-family="system-ui">G</text>
  </g>
</svg>`,
        controls_html: `
<div id="controls-panel" style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">DNA Replication</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;line-height:1.5;">DNA replication is semi-conservative: each new DNA molecule contains one original strand and one newly synthesized strand.</p>
  <div id="info-panel" style="padding:16px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <div id="info-title" style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">Key Enzymes</div>
    <div id="info-desc" style="font-size:13px;color:#475569;line-height:1.5;"><b>Helicase</b> unzips the double helix. <b>DNA Polymerase</b> adds nucleotides to build new strands. The leading strand is synthesized continuously, while the lagging strand is made in short Okazaki fragments.</div>
  </div>
</div>`,
        narration_context: "This diagram shows a DNA replication fork. On the left is the original parent DNA double helix. Helicase unzips the two strands at the fork. The leading strand is synthesized continuously in the 3' to 5' direction, while the lagging strand is made in short Okazaki fragments.",
        source_labels: ['DNA Replication — Biology']
    },
    {
        id: 'water-cycle',
        title: 'Water Cycle',
        emoji: '🌊',
        description: 'Evaporation, condensation, and precipitation explained.',
        svg_html: `
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-height:90vh">
  <defs>
    <linearGradient id="skyG" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#7dd3fc"/><stop offset="100%" stop-color="#bae6fd"/></linearGradient>
    <linearGradient id="waterG" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient>
    <linearGradient id="groundG" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#65a30d"/><stop offset="100%" stop-color="#4d7c0f"/></linearGradient>
  </defs>
  <rect width="800" height="500" fill="url(#skyG)" rx="16"/>
  <!-- Ground -->
  <path d="M 0 380 Q 100 360, 200 370 Q 350 385, 500 360 Q 600 350, 700 365 Q 750 370, 800 375 L 800 500 L 0 500 Z" fill="url(#groundG)"/>
  <!-- Water body -->
  <path d="M 0 390 Q 80 400, 180 395 L 180 500 L 0 500 Z" fill="url(#waterG)" opacity="0.8"/>
  <text x="90" y="440" text-anchor="middle" fill="white" font-size="13" font-weight="600" font-family="system-ui">Lake</text>
  <!-- Sun -->
  <circle cx="700" cy="80" r="40" fill="#fbbf24"/>
  <g stroke="#fbbf24" stroke-width="2" opacity="0.6">
    <line x1="700" y1="25" x2="700" y2="10"/><line x1="700" y1="135" x2="700" y2="150"/>
    <line x1="645" y1="80" x2="630" y2="80"/><line x1="755" y1="80" x2="770" y2="80"/>
    <line x1="660" y1="40" x2="650" y2="30"/><line x1="740" y1="120" x2="750" y2="130"/>
    <line x1="740" y1="40" x2="750" y2="30"/><line x1="660" y1="120" x2="650" y2="130"/>
  </g>
  <!-- Evaporation arrows -->
  <g id="evaporation">
    <path d="M 100 380 Q 110 320, 130 280" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-dasharray="6 4" marker-end="url(#arrowBlue)"/>
    <path d="M 140 375 Q 155 310, 170 270" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-dasharray="6 4"/>
    <text x="80" y="330" fill="#1d4ed8" font-size="12" font-weight="600" font-family="system-ui" transform="rotate(-70, 80, 330)">Evaporation</text>
  </g>
  <!-- Cloud -->
  <g id="cloud" transform="translate(350, 100)">
    <ellipse cx="0" cy="0" rx="70" ry="35" fill="white" opacity="0.95"/>
    <ellipse cx="-40" cy="10" rx="40" ry="28" fill="white" opacity="0.95"/>
    <ellipse cx="40" cy="10" rx="45" ry="30" fill="white" opacity="0.95"/>
    <ellipse cx="0" cy="20" rx="60" ry="25" fill="white" opacity="0.95"/>
  </g>
  <text x="350" y="80" text-anchor="middle" fill="#475569" font-size="12" font-weight="600" font-family="system-ui">Cloud Formation</text>
  <!-- Condensation label -->
  <g id="condensation">
    <path d="M 220 260 Q 270 200, 310 140" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="240" y="195" fill="#7c3aed" font-size="12" font-weight="600" font-family="system-ui" transform="rotate(-55, 240, 195)">Condensation</text>
  </g>
  <!-- Precipitation -->
  <g id="precipitation">
    <line x1="340" y1="140" x2="330" y2="200" stroke="#3b82f6" stroke-width="2.5"/>
    <line x1="360" y1="145" x2="350" y2="220" stroke="#3b82f6" stroke-width="2.5"/>
    <line x1="380" y1="140" x2="370" y2="210" stroke="#3b82f6" stroke-width="2.5"/>
    <line x1="320" y1="142" x2="310" y2="190" stroke="#3b82f6" stroke-width="2.5"/>
    <text x="380" y="200" fill="#1d4ed8" font-size="12" font-weight="600" font-family="system-ui">Precipitation</text>
  </g>
  <!-- Runoff arrow -->
  <g id="runoff">
    <path d="M 350 370 Q 280 390, 200 400" fill="none" stroke="#0ea5e9" stroke-width="3" stroke-dasharray="8 4"/>
    <text x="280" y="410" fill="#0369a1" font-size="12" font-weight="600" font-family="system-ui">Runoff</text>
  </g>
  <!-- Mountains -->
  <g id="mountains">
    <path d="M 500 370 L 560 280 L 620 370" fill="#4d7c0f" stroke="#365314" stroke-width="1"/>
    <path d="M 580 370 L 650 250 L 720 370" fill="#3f6212" stroke="#365314" stroke-width="1"/>
    <path d="M 630 268 L 650 250 L 670 268" fill="white" opacity="0.8"/>
  </g>
  <!-- Groundwater -->
  <g id="groundwater">
    <path d="M 200 470 Q 400 460, 600 475" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="4 3"/>
    <text x="400" y="490" text-anchor="middle" fill="#0369a1" font-size="11" font-family="system-ui">Groundwater Flow</text>
  </g>
</svg>`,
        controls_html: `
<div id="controls-panel" style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">The Water Cycle</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;line-height:1.5;">Water continuously moves through the atmosphere, land, and oceans in a cycle driven by solar energy and gravity.</p>
  <div id="info-panel" style="padding:16px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <div id="info-title" style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">Stages</div>
    <div id="info-desc" style="font-size:13px;color:#475569;line-height:1.5;"><b>Evaporation</b>: Sun heats water, turning it to vapor. <b>Condensation</b>: Vapor cools and forms clouds. <b>Precipitation</b>: Water falls as rain/snow. <b>Runoff</b>: Water flows back to lakes and oceans.</div>
  </div>
</div>`,
        narration_context: "This diagram shows the water cycle. The sun heats a lake causing evaporation. Water vapor rises, condenses into clouds, and falls as precipitation (rain). Water runs off the mountains back into the lake, completing the cycle. Groundwater flow is shown underground.",
        source_labels: ['Water Cycle — USGS']
    },
    {
        id: 'electric-circuits',
        title: 'Electric Circuits',
        emoji: '⚡',
        description: 'Series vs parallel circuits and how current flows.',
        svg_html: `
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-height:90vh">
  <rect width="800" height="500" fill="#f8fafc" rx="16"/>
  <!-- Title -->
  <text x="400" y="35" text-anchor="middle" fill="#0f172a" font-size="16" font-weight="700" font-family="system-ui">Series vs Parallel Circuits</text>
  <!-- Series Circuit (left) -->
  <g id="series-circuit" transform="translate(50, 60)">
    <text x="150" y="20" text-anchor="middle" fill="#475569" font-size="14" font-weight="600" font-family="system-ui">Series Circuit</text>
    <!-- Wires -->
    <path d="M 50 80 L 250 80 L 250 140 L 250 200 L 250 300 L 50 300 L 50 80" fill="none" stroke="#334155" stroke-width="3" stroke-linejoin="round"/>
    <!-- Battery -->
    <rect x="30" y="160" width="40" height="80" rx="4" fill="white" stroke="#334155" stroke-width="2"/>
    <line x1="40" y1="178" x2="60" y2="178" stroke="#334155" stroke-width="3"/>
    <line x1="46" y1="192" x2="54" y2="192" stroke="#334155" stroke-width="2"/>
    <text x="50" y="260" text-anchor="middle" fill="#475569" font-size="10" font-family="system-ui">9V</text>
    <!-- Bulb 1 -->
    <circle cx="150" cy="80" r="18" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/>
    <text x="150" y="84" text-anchor="middle" fill="#92400e" font-size="10" font-weight="600" font-family="system-ui">R₁</text>
    <text x="150" y="110" text-anchor="middle" fill="#475569" font-size="10" font-family="system-ui">3Ω</text>
    <!-- Bulb 2 -->
    <circle cx="250" cy="200" r="18" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/>
    <text x="250" y="204" text-anchor="middle" fill="#92400e" font-size="10" font-weight="600" font-family="system-ui">R₂</text>
    <text x="280" y="204" fill="#475569" font-size="10" font-family="system-ui">3Ω</text>
    <!-- Current arrow -->
    <path d="M 100 70 L 120 70" fill="none" stroke="#ef4444" stroke-width="2" marker-end="url(#arrR)"/>
    <text x="110" y="62" text-anchor="middle" fill="#ef4444" font-size="10" font-weight="600" font-family="system-ui">I = 1.5A</text>
    <!-- Formula -->
    <text x="150" y="340" text-anchor="middle" fill="#475569" font-size="11" font-family="system-ui">R_total = R₁ + R₂ = 6Ω</text>
    <text x="150" y="360" text-anchor="middle" fill="#475569" font-size="11" font-family="system-ui">I = V/R = 9/6 = 1.5A</text>
    <text x="150" y="385" text-anchor="middle" fill="#dc2626" font-size="11" font-weight="600" font-family="system-ui">Same current everywhere</text>
  </g>
  <!-- Parallel Circuit (right) -->
  <g id="parallel-circuit" transform="translate(430, 60)">
    <text x="150" y="20" text-anchor="middle" fill="#475569" font-size="14" font-weight="600" font-family="system-ui">Parallel Circuit</text>
    <!-- Main wires -->
    <path d="M 50 80 L 50 300 L 250 300 L 250 80 L 50 80" fill="none" stroke="#334155" stroke-width="3" stroke-linejoin="round"/>
    <!-- Branch wires -->
    <line x1="100" y1="80" x2="100" y2="300" stroke="#334155" stroke-width="2"/>
    <line x1="200" y1="80" x2="200" y2="300" stroke="#334155" stroke-width="2"/>
    <!-- Battery -->
    <rect x="30" y="160" width="40" height="80" rx="4" fill="white" stroke="#334155" stroke-width="2"/>
    <line x1="40" y1="178" x2="60" y2="178" stroke="#334155" stroke-width="3"/>
    <line x1="46" y1="192" x2="54" y2="192" stroke="#334155" stroke-width="2"/>
    <text x="50" y="260" text-anchor="middle" fill="#475569" font-size="10" font-family="system-ui">9V</text>
    <!-- Bulb 1 -->
    <circle cx="100" cy="190" r="18" fill="#dcfce7" stroke="#22c55e" stroke-width="2"/>
    <text x="100" y="194" text-anchor="middle" fill="#15803d" font-size="10" font-weight="600" font-family="system-ui">R₁</text>
    <text x="127" y="194" fill="#475569" font-size="10" font-family="system-ui">3Ω</text>
    <!-- Bulb 2 -->
    <circle cx="200" cy="190" r="18" fill="#dcfce7" stroke="#22c55e" stroke-width="2"/>
    <text x="200" y="194" text-anchor="middle" fill="#15803d" font-size="10" font-weight="600" font-family="system-ui">R₂</text>
    <text x="227" y="194" fill="#475569" font-size="10" font-family="system-ui">3Ω</text>
    <!-- Current arrows -->
    <text x="100" y="145" text-anchor="middle" fill="#2563eb" font-size="9" font-weight="600" font-family="system-ui">3A</text>
    <text x="200" y="145" text-anchor="middle" fill="#2563eb" font-size="9" font-weight="600" font-family="system-ui">3A</text>
    <text x="40" y="130" fill="#ef4444" font-size="10" font-weight="600" font-family="system-ui">6A</text>
    <!-- Formula -->
    <text x="150" y="340" text-anchor="middle" fill="#475569" font-size="11" font-family="system-ui">1/R = 1/R₁ + 1/R₂ = 1/1.5Ω</text>
    <text x="150" y="360" text-anchor="middle" fill="#475569" font-size="11" font-family="system-ui">I_total = 3A + 3A = 6A</text>
    <text x="150" y="385" text-anchor="middle" fill="#16a34a" font-size="11" font-weight="600" font-family="system-ui">Same voltage everywhere</text>
  </g>
  <!-- VS label -->
  <text x="415" y="260" text-anchor="middle" fill="#94a3b8" font-size="24" font-weight="700" font-family="system-ui">vs</text>
</svg>`,
        controls_html: `
<div id="controls-panel" style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">Electric Circuits</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;line-height:1.5;">The two fundamental circuit configurations. Each has very different behavior in terms of current flow and voltage distribution.</p>
  <div id="info-panel" style="padding:16px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <div id="info-title" style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">Key Difference</div>
    <div id="info-desc" style="font-size:13px;color:#475569;line-height:1.5;"><b>Series</b>: Components share the same current. If one bulb breaks, all go out. <b>Parallel</b>: Components share the same voltage. Each branch works independently — this is how your house is wired!</div>
  </div>
</div>`,
        narration_context: "This diagram compares series and parallel circuits side by side. The series circuit on the left shows two 3-ohm resistors in series with a 9V battery, resulting in 1.5 amps everywhere. The parallel circuit on the right shows the same resistors in parallel, with 3 amps through each branch and 6 amps total.",
        source_labels: ['Electric Circuits — Physics']
    },
    {
        id: 'photosynthesis',
        title: 'Photosynthesis',
        emoji: '🌱',
        description: 'How plants convert sunlight into chemical energy.',
        svg_html: `
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-height:90vh">
  <defs>
    <linearGradient id="leafG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#15803d"/></linearGradient>
    <linearGradient id="cellG" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#bbf7d0"/><stop offset="100%" stop-color="#86efac"/></linearGradient>
  </defs>
  <rect width="800" height="500" fill="#f0fdf4" rx="16"/>
  <!-- Leaf shape -->
  <g id="leaf" transform="translate(100, 50)">
    <path d="M 300 20 Q 450 20, 550 100 Q 600 150, 580 220 Q 560 280, 480 340 Q 400 380, 300 400 Q 200 380, 120 340 Q 40 280, 20 220 Q 0 150, 50 100 Q 150 20, 300 20" fill="url(#leafG)" stroke="#15803d" stroke-width="2"/>
    <!-- Leaf veins -->
    <path d="M 300 20 L 300 400" fill="none" stroke="#166534" stroke-width="2" opacity="0.3"/>
    <path d="M 300 150 Q 200 130, 120 180" fill="none" stroke="#166534" stroke-width="1.5" opacity="0.2"/>
    <path d="M 300 220 Q 420 200, 520 240" fill="none" stroke="#166534" stroke-width="1.5" opacity="0.2"/>
    <path d="M 300 280 Q 180 270, 100 300" fill="none" stroke="#166534" stroke-width="1.5" opacity="0.2"/>
    <!-- Chloroplast cell -->
    <ellipse cx="300" cy="210" rx="140" ry="90" fill="url(#cellG)" stroke="#22c55e" stroke-width="2" opacity="0.9"/>
    <text x="300" y="165" text-anchor="middle" fill="#14532d" font-size="13" font-weight="700" font-family="system-ui">Chloroplast</text>
    <!-- Thylakoid stacks -->
    <g transform="translate(230, 190)">
      <rect x="0" y="0" width="50" height="8" rx="4" fill="#16a34a" opacity="0.7"/>
      <rect x="0" y="12" width="50" height="8" rx="4" fill="#16a34a" opacity="0.7"/>
      <rect x="0" y="24" width="50" height="8" rx="4" fill="#16a34a" opacity="0.7"/>
      <rect x="0" y="36" width="50" height="8" rx="4" fill="#16a34a" opacity="0.7"/>
      <text x="25" y="60" text-anchor="middle" fill="#14532d" font-size="9" font-family="system-ui">Thylakoid</text>
    </g>
    <!-- Stroma label -->
    <text x="370" y="250" fill="#14532d" font-size="10" font-family="system-ui">Stroma</text>
    <text x="370" y="262" fill="#14532d" font-size="9" font-family="system-ui">(Calvin Cycle)</text>
  </g>
  <!-- Inputs -->
  <g id="inputs">
    <!-- Sunlight -->
    <g transform="translate(50, 30)">
      <circle r="25" fill="#fbbf24"/>
      <g stroke="#fbbf24" stroke-width="2"><line x1="30" y1="0" x2="45" y2="0"/><line x1="-30" y1="0" x2="-45" y2="0"/><line x1="0" y1="-30" x2="0" y2="-5"/><line x1="21" y1="21" x2="32" y2="32"/><line x1="-21" y1="21" x2="-32" y2="32"/></g>
    </g>
    <path d="M 80 65 Q 150 80, 200 100" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="6 4"/>
    <text x="120" y="70" fill="#b45309" font-size="12" font-weight="600" font-family="system-ui">Sunlight</text>
    <!-- CO2 -->
    <text x="50" y="350" fill="#475569" font-size="14" font-weight="700" font-family="system-ui">CO₂</text>
    <path d="M 80 340 Q 140 300, 200 270" fill="none" stroke="#64748b" stroke-width="2.5" stroke-dasharray="6 4"/>
    <!-- Water -->
    <text x="50" y="430" fill="#2563eb" font-size="14" font-weight="700" font-family="system-ui">H₂O</text>
    <path d="M 85 420 Q 160 380, 220 340" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-dasharray="6 4"/>
  </g>
  <!-- Outputs -->
  <g id="outputs">
    <!-- Glucose -->
    <path d="M 580 230 Q 650 230, 700 210" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="6 4"/>
    <text x="720" y="205" fill="#b45309" font-size="14" font-weight="700" font-family="system-ui">C₆H₁₂O₆</text>
    <text x="720" y="222" fill="#92400e" font-size="11" font-family="system-ui">(Glucose)</text>
    <!-- Oxygen -->
    <path d="M 560 310 Q 640 340, 700 340" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-dasharray="6 4"/>
    <text x="720" y="345" fill="#15803d" font-size="14" font-weight="700" font-family="system-ui">O₂</text>
    <text x="720" y="362" fill="#166534" font-size="11" font-family="system-ui">(Oxygen)</text>
  </g>
  <!-- Equation -->
  <text x="400" y="480" text-anchor="middle" fill="#475569" font-size="13" font-weight="600" font-family="system-ui">6CO₂ + 6H₂O + Light → C₆H₁₂O₆ + 6O₂</text>
</svg>`,
        controls_html: `
<div id="controls-panel" style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">Photosynthesis</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;line-height:1.5;">Photosynthesis converts light energy into chemical energy (glucose), releasing oxygen as a byproduct. It occurs in chloroplasts in plant cells.</p>
  <div id="info-panel" style="padding:16px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <div id="info-title" style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">Two Stages</div>
    <div id="info-desc" style="font-size:13px;color:#475569;line-height:1.5;"><b>Light Reactions</b> (thylakoids): Capture sunlight to produce ATP and NADPH. <b>Calvin Cycle</b> (stroma): Uses ATP and NADPH to fix CO₂ into glucose. Together they sustain almost all life on Earth.</div>
  </div>
</div>`,
        narration_context: "This diagram shows the photosynthesis process inside a leaf's chloroplast. The inputs are sunlight, carbon dioxide, and water. Inside the chloroplast, thylakoids perform light reactions while the stroma hosts the Calvin Cycle. The outputs are glucose (chemical energy) and oxygen.",
        source_labels: ['Photosynthesis — Biology']
    }
]
