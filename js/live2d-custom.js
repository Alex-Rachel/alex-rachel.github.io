// ================== Live2D 看板娘高级功能 ===================
// TTS 已关闭

// ================== 点击触发气泡 ===================
document.addEventListener('click', function(e) {
    if (e.target.closest('#live2dcanvas') || e.target.closest('.live2d')) {
        const phrases = [
            '主人～点我干嘛呀～',
            '嘿嘿，被你发现了！',
            '专心看博客哦～',
            '要好好学习天天向上！',
            'coding time!',
            '一起加油吧～'
        ];
        const phrase = phrases[Math.floor(Math.random() * phrases.length)];
        showSpeechBubble(phrase);
    }
});

// ================== 悬停气泡 ===================
document.addEventListener('mouseover', function(e) {
    if (e.target.closest('#live2dcanvas') || e.target.closest('.live2d')) {
        const phrases = ['主人来啦～', '看我看我！', '今天也要加油哦', '一起玩耍吧～'];
        const phrase = phrases[Math.floor(Math.random() * phrases.length)];
        showSpeechBubble(phrase);
    }
});

// ================== 气泡对话 ===================
function showSpeechBubble(text) {
    const existing = document.querySelector('.live2d-speech-bubble');
    if (existing) existing.remove();
    
    const bubble = document.createElement('div');
    bubble.className = 'live2d-speech-bubble';
    bubble.innerHTML = `
        ${text}
        <div class="bubble-tail"></div>
    `;
    bubble.style.cssText = `
        position: fixed;
        bottom: 260px;
        right: 15px;
        background: linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%);
        color: #333;
        padding: 12px 18px;
        border-radius: 20px;
        font-size: 14px;
        max-width: 180px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        z-index: 9999;
        animation: fadeInUp 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        cursor: default;
    `;
    
    // Inject animation
    if (!document.getElementById('bubble-style')) {
        const style = document.createElement('style');
        style.id = 'bubble-style';
        style.textContent = `
            @keyframes fadeInUp {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .bubble-tail {
                position: absolute;
                bottom: -8px;
                right: 30px;
                width: 0;
                height: 0;
                border-left: 10px solid transparent;
                border-right: 10px solid transparent;
                border-top: 10px solid #fecfef;
            }
        `;
        document.head.appendChild(style);
    }
    
    document.body.appendChild(bubble);
    
    setTimeout(() => {
        bubble.style.opacity = '0';
        bubble.style.transition = 'opacity 0.3s';
        setTimeout(() => bubble.remove(), 300);
    }, 3000);
}

// ================== 一言 API（仅气泡，无TTS） ===================
async function fetchHitokoto() {
    try {
        const res = await fetch('https://v1.hitokoto.cn/');
        const data = await res.json();
        return data.hitokoto;
    } catch {
        return '今天也要开心哦～';
    }
}

// 每60秒自动说一言（仅气泡）
setInterval(async () => {
    if (!document.querySelector('.live2d-speech-bubble')) {
        const phrase = await fetchHitokoto();
        showSpeechBubble(phrase);
    }
}, 60000);
