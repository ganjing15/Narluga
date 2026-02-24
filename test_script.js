    let isPlaying = false;
    let playInterval;
    
    function init() {
        const pathsToMeasure = [
            \`root-1\`, \`root-2\`, \`root-3\`, \`root-4\`, \`stem\`
        ];
        
        // Initialize dynamic paths with their total lengths for CSS dash-offset drawing
        pathsToMeasure.forEach(id => {
            const el = document.getElementById(id);
            if(el) {
                // Add tiny buffer to length to ensure completely hidden when offset
                const len = el.getTotalLength() + 5; 
                el.setAttribute(\`stroke-dasharray\`, len);
                el.setAttribute(\`stroke-dashoffset\`, len);
                el.dataset.len = len; 
            }
        });
        
        // Ensure starting state is correctly rendered
        updateState(0);
    }

    function updateState(val) {
        val = Number(val);
        
        // --- 1. Mutate SVG Visually ---

        // Stage 1: Seed Swells (0-20%)
        let seedScale = 1;
        if (val < 20) {
            seedScale = 1 + (val / 20) * 0.4;
        } else {
            seedScale = 1.4;
        }
        document.getElementById(\`seed-group\`).setAttribute(\`transform\`, \`translate(400 340) scale(\${seedScale}) translate(-400 -340)\`);
        
        // Stage 2: Roots Grow Down (20-40%)
        let rootProgress = Math.max(0, Math.min(1, (val - 20) / 20));
        const rootIds = [\`root-1\`, \`root-2\`, \`root-3\`, \`root-4\`];
        rootIds.forEach(id => {
            let el = document.getElementById(id);
            if(el && el.dataset.len) {
                el.setAttribute(\`stroke-dashoffset\`, el.dataset.len * (1 - rootProgress));
            }
        });
        
        // Stage 3: Stem Grows Up (40-60%)
        let stemProgress = Math.max(0, Math.min(1, (val - 40) / 20));
        let stemEl = document.getElementById(\`stem\`);
        if (stemEl && stemEl.dataset.len) {
            stemEl.setAttribute(\`stroke-dashoffset\`, stemEl.dataset.len * (1 - stemProgress));
        }
        
        // Stage 4: Leaves Sprout & Unfold (60-80%)
        let leafProgress = Math.max(0, Math.min(1, (val - 60) / 20));
        // Use an ease-out sine wave for a more natural pop
        let leafEase = Math.sin(leafProgress * Math.PI / 2);
        document.getElementById(\`leaf-left\`).setAttribute(\`transform\`, \`translate(390 260) scale(\${leafEase}) translate(-390 -260)\`);
        document.getElementById(\`leaf-right\`).setAttribute(\`transform\`, \`translate(405 210) scale(\${leafEase}) translate(-405 -210)\`);
        
        // Stage 5: Flower Blooms (80-100%)
        let flowerProgress = Math.max(0, Math.min(1, (val - 80) / 20));
        let flowerEase = Math.sin(flowerProgress * Math.PI / 2);
        document.getElementById(\`flower-group\`).setAttribute(\`transform\`, \`translate(400 180) scale(\${flowerEase}) translate(-400 -180)\`);
        
        // --- 2. Update Labels Opacity ---
        document.getElementById(\`label-seed\`).style.opacity = val >= 5 ? 1 : 0;
        document.getElementById(\`label-roots\`).style.opacity = val >= 30 ? 1 : 0;
        document.getElementById(\`label-stem\`).style.opacity = val >= 50 ? 1 : 0;
        document.getElementById(\`label-leaves\`).style.opacity = val >= 70 ? 1 : 0;
        document.getElementById(\`label-flower\`).style.opacity = val >= 90 ? 1 : 0;
        
        // --- 3. Update Text Info Panel ---
        let title = document.getElementById(\`info-title\`);
        let desc = document.getElementById(\`info-desc\`);
        
        if (val < 20) {
            title.textContent = \`Stage 1: Germination\`;
            desc.textContent = \`The planted seed absorbs moisture from the soil, causing it to swell and prepare to break open its protective outer coat.\`;
        } else if (val < 40) {
            title.textContent = \`Stage 2: Root Growth\`;
            desc.textContent = \`Roots emerge and grow rapidly downward. They anchor the plant into the earth and absorb vital water and minerals.\`;
        } else if (val < 60) {
            title.textContent = \`Stage 3: Sprouting\`;
            desc.textContent = \`A strong shoot pushes upward. Guided by sunlight and gravity, the young stem breaks through the surface of the soil.\`;
        } else if (val < 80) {
            title.textContent = \`Stage 4: Vegetative Growth\`;
            desc.textContent = \`Vibrant green leaves unfold to capture sunlight. Through photosynthesis, the plant creates the energy it needs to mature.\`;
        } else {
            title.textContent = \`Stage 5: Flowering\`;
            desc.textContent = \`Upon reaching maturity, the plant blossoms with a flower. This structure allows the plant to reproduce and eventually create new seeds.\`;
        }
        
        // --- 4. Send AI Telemetry ---
        if (window.sendEventToAI && (val % 25 === 0)) {
            window.sendEventToAI(\`User shifted plant growth phase to \${val}%\`);
        }
    }
    
    function togglePlay() {
        isPlaying = !isPlaying;
        const btn = document.getElementById(\`playBtn\`);
        const icon = document.getElementById(\`playIcon\`);
        const text = document.getElementById(\`playText\`);
        
        if (isPlaying) {
            btn.style.backgroundColor = \`#047857\`;
            text.textContent = \`Pause Growth\`;
            icon.innerHTML = \`<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>\`; // Pause icon
            
            // Auto restart if at the very end
            let slider = document.getElementById(\`timeSlider\`);
            if(Number(slider.value) === 100) slider.value = 0;

            playInterval = setInterval(() => {
                let currentVal = Number(slider.value);
                if (currentVal >= 100) {
                    togglePlay(); // auto stop at end
                } else {
                    let nextVal = currentVal + 0.5;
                    slider.value = nextVal;
                    updateState(nextVal);
                }
            }, 30);
        } else {
            btn.style.backgroundColor = \`#059669\`;
            text.textContent = \`Auto-Play Growth\`;
            icon.innerHTML = \`<path d="M8 5v14l11-7z"/>\`; // Play icon
            clearInterval(playInterval);
        }
    }

    // Initialize the drawing paths instantly once the panel loads
    setTimeout(init, 50);

