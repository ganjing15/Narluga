const { chromium } = require('playwright');
const path = require('path');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    page.on('console', msg => {
        if (msg.type() === 'error') console.log(`BROWSER ERROR: ${msg.text()}`);
        else console.log(`BROWSER LOG: ${msg.text()}`);
    });

    page.on('pageerror', error => {
        console.log(`PAGE EXCEPTION: ${error.message}`);
    });

    const fileUrl = 'file://' + path.resolve('/Users/jing/Gemini Live Agent Challenge/backend/generated_graphics/the_plant_life_cycle_20260223_125434.html');
    console.log("Navigating to", fileUrl);

    await page.goto(fileUrl);

    // Wait a moment for init to run
    await page.waitForTimeout(500);

    console.log("Clicking Play button...");
    await page.click('#playBtn');

    // Wait to see if any errors are triggered
    await page.waitForTimeout(1000);

    console.log("Dragging slider...");
    const slider = await page.$('#timeSlider');
    if (slider) {
        await slider.evaluate(node => {
            node.value = 50;
            node.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    await page.waitForTimeout(1000);

    await browser.close();
    console.log("Done.");
})();
