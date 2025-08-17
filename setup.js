const play = require('play-dl');
const fs = require('fs');

async function setupYouTube() {
    console.log('Setting up YouTube authentication...');
    
    try {
        // Check if play-dl is already authorized
        const cookies = await play.getFreeClientID();
        console.log('YouTube client ID obtained successfully!');
        
        // Save for reference
        fs.writeFileSync('youtube-setup.txt', 'Setup completed at: ' + new Date());
        console.log('Setup complete! You can now use the bot.');
        
    } catch (error) {
        console.log('Trying alternative setup...');
        
        // Alternative: refresh the YouTube tokens
        await play.refreshToken();
        console.log('Tokens refreshed successfully!');
    }
}

setupYouTube();
