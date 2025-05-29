// 内容脚本，处理页面交互和注入UI
console.log("Content script loaded");

/**
 * 监听 background.js 的清空缓存请求
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "clearCache") {
    // 生成所有字幕的缓存key
    const videoKey =
      typeof location !== "undefined"
        ? (function hashCode(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
              hash = (hash << 5) - hash + str.charCodeAt(i);
              hash |= 0;
            }
            return hash;
          })(location.href)
        : 0;
    const keys = subtitles.map((sub) => `audio_${videoKey}_${sub.id}`);
    // 批量移除缓存
    chrome.storage.local.remove(keys, () => {
      // 重置字幕状态
      subtitles.forEach((sub) => {
        sub.audioStatus = "unloaded";
        sub.audioUrl = null;
        sub.audioDuration = null;
        sub.playbackRate = null;
      });
      // 刷新界面并重新加载音频
      if (typeof renderSubtitleList === "function") renderSubtitleList();
      // 移除批量加载全部音频的自动调用
    });
  }
});

// 存储字幕和音频数据
let subtitles = [];
// const audioCache = {}; // 不再使用单独的 cache，信息存入 subtitles
let popupDiv = null; // 引用注入的div
let shadowRoot = null; // 引用Shadow DOM
let currentAudio = null; // 跟踪当前播放的音频对象
let floatingControlBtn = null; // 引用浮动控制按钮
// let playPauseBtn = null; // 已彻底移除主播放按钮
let lastPlayedSubtitleId = null; // 记录上一次已播放音频的字幕ID
let isReload = false; // 是否重新加载字幕音频
let isLearn = false; // 是否处于语言学习模式
let pausedForSubtitleId = null; // 记录因等待哪个字幕音频而暂停的ID
let batchLoadingCanceled = false; // 控制批量加载是否被取消
let batchLoadingInProgress = false; // 标记是否正在进行批量加载
let isMuted = false; // 是否静音

// 将关键变量暴露到window对象中，便于调试和测试
window.batchLoadingCanceled = batchLoadingCanceled;
window.batchLoadingInProgress = batchLoadingInProgress;

// 查找视频元素 - 支持动态加载
let video = null;
let subtitleBar = null;
let currentLanguage = "zh"; // 默认中文
let videoInitialized = false; // 标记视频是否已初始化

// 从storage获取语言设置
chrome.storage.sync.get(["language"], (result) => {
  if (result.language) {
    currentLanguage = result.language;
  }
});

// 监听语言设置变化
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.language) {
    currentLanguage = changes.language.newValue;
  }
});

// 动态查找视频元素的函数
function findVideoElement() {
  // 尝试多种选择器，适配不同网站的视频结构
  const selectors = [
    'video', // 标准video元素
    '.bwp-video video', // Bilibili专用
    '.bilibili-player-video video', // Bilibili播放器
    '.player-video video', // 通用播放器
    '[data-video] video', // 带data-video属性的容器中的视频
  ];
  
  for (const selector of selectors) {
    const foundVideo = document.querySelector(selector);
    if (foundVideo && foundVideo.readyState >= 1) { // 确保视频有数据
      console.log(`找到视频元素: ${selector}`);
      return foundVideo;
    }
  }
  return null;
}

// 初始化视频相关功能
function initializeVideo(videoElement) {
  if (videoInitialized && video === videoElement) {
    return; // 避免重复初始化同一个视频元素
  }
  
  video = videoElement;
  videoInitialized = true;
  
  console.log("初始化视频元素及相关功能");
  
  // 创建字幕栏（仅在检测到视频时创建）
  if (subtitleBar) {
    subtitleBar.remove(); // 移除旧的字幕栏
    subtitleBar = null;
  }
  
  // 检测到视频元素时才创建字幕栏
  if (video) {
    subtitleBar = createSubtitleBar();
  } else {
    console.log("未检测到视频元素，不创建字幕栏");
  }

  // 监听播放速率变化
  video.addEventListener("ratechange", () => {
    if (subtitleBar) {
      const speedText = subtitleBar.querySelector("#subtitle-speed");
      if (speedText) {
        speedText.textContent = `速度: ${video.playbackRate.toFixed(1)}x`;
      }
    }
  });
  
  // 监听视频播放进度
  video.addEventListener("timeupdate", () => {
    const currentTime = video.currentTime;
    const currentSubtitleIndex = subtitles.findIndex(
      (sub) => currentTime >= sub.startTime && currentTime <= sub.endTime
    );

    if (currentSubtitleIndex !== -1) {
      const currentSubtitle = subtitles[currentSubtitleIndex];
      updateCurrentSubtitleDisplay(currentSubtitle.text);

      // 懒加载逻辑：加载当前及前后字幕的音频
      const preloadStart = Math.max(0, currentSubtitleIndex - 2);
      const preloadEnd = Math.min(
        subtitles.length - 1,
        currentSubtitleIndex + 2
      );
      for (let i = preloadStart; i <= preloadEnd; i++) {
        if (subtitles[i].audioStatus === "unloaded") {
          loadAudio(subtitles[i]);
        }
      }

      // 播放或暂停逻辑
      if (currentSubtitle.audioStatus === "loaded") {
        // 音频已加载
        if (pausedForSubtitleId === currentSubtitle.id) {
          // 如果视频是因为等待这个字幕而暂停的
          // 注意：实际的 video.play() 和 playAudio() 将在 loadAudio 的回调中触发
          // 这里不需要做额外操作，等待 loadAudio 回调处理
          // console.log(`音频 ${currentSubtitle.id} 已加载，等待 loadAudio 回调恢复播放。`);
        } else if (
          !video.paused &&
          lastPlayedSubtitleId !== currentSubtitle.id
        ) {
          // 如果视频正在播放且不是重复播放同一条，则播放音频
          playAudio(currentSubtitle.audioUrl, currentSubtitle.id, false);
          lastPlayedSubtitleId = currentSubtitle.id;
        } else if (
          video.paused &&
          lastPlayedSubtitleId !== currentSubtitle.id &&
          pausedForSubtitleId !== currentSubtitle.id
        ) {
          // 如果视频暂停了（非等待状态），但字幕切换了，重置播放ID
          lastPlayedSubtitleId = null;
        }
      } else {
        // 音频未加载 (unloaded, loading, failed)
        if (!video.paused) {
          // 只有在视频正在播放时才因音频未就绪而暂停
          console.log(
            `音频 ${currentSubtitle.id} 未就绪 (${currentSubtitle.audioStatus})，暂停视频。`
          );
          video.pause(); // 暂停视频
          pausedForSubtitleId = currentSubtitle.id; // 记录等待的字幕ID
        } else if (pausedForSubtitleId !== currentSubtitle.id) {
          // 如果视频已暂停，但不是因为等待当前字幕，也更新等待标记，以便音频加载后能正确判断
          pausedForSubtitleId = currentSubtitle.id;
        }
        lastPlayedSubtitleId = null; // 重置播放ID，因为音频未播放
        // 如果是 unloaded 状态，loadAudio 已在上面触发
      }
    } else {
      // 当前时间无对应字幕
      updateCurrentSubtitleDisplay(""); // 清空字幕显示
      lastPlayedSubtitleId = null;
      if (pausedForSubtitleId) {
        // 如果之前在等待字幕，现在没有字幕了，清除等待标记
        pausedForSubtitleId = null;
      }
      // 不在此处自动暂停视频，除非有明确需求
    }
  });
  
  // 监听窗口大小变化和视频尺寸变化重新定位字幕栏
  window.addEventListener("resize", () => {
    if (subtitleBar) positionSubtitleBar();
  });

  // 监听视频大小变化
  const resizeObserver = new ResizeObserver(() => {
    if (subtitleBar) positionSubtitleBar();
  });
  resizeObserver.observe(video);
  
  // 视频初始化完成后，如果浮动按钮存在且没有自定义位置，重新定位到视频左上角
  if (floatingControlBtn) {
    chrome.storage.local.get(["floatingBtnPos"], (result) => {
      if (!result.floatingBtnPos) {
        console.log("Video initialized, repositioning floating button to video top-left");
        setDefaultFloatingButtonPosition(floatingControlBtn);
      }
    });
  }
}

// 设置视频检测和重试机制
function setupVideoDetection() {
  let retryCount = 0;
  const maxRetries = 10;
  const retryInterval = 1000; // 1秒

  function checkForVideo() {
    const foundVideo = findVideoElement();
    if (foundVideo) {
      initializeVideo(foundVideo);
      return;
    }
    
    retryCount++;
    if (retryCount < maxRetries) {
      console.log(`未找到视频元素，${retryInterval/1000}秒后重试 (${retryCount}/${maxRetries})`);
      setTimeout(checkForVideo, retryInterval);
    } else {
      console.log("达到最大重试次数，停止查找视频元素");
    }
  }

  // 立即检查一次
  checkForVideo();

  // 设置DOM变化监听器
  const observer = new MutationObserver((mutations) => {
    if (video) return; // 如果已找到视频，停止监听
    
    // 检查是否有新的video元素被添加
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // 检查新添加的节点是否包含video元素
            if (node.tagName === 'VIDEO' || node.querySelector('video')) {
              const foundVideo = findVideoElement();
              if (foundVideo) {
                initializeVideo(foundVideo);
                observer.disconnect(); // 停止观察
                return;
              }
            }
          }
        }
      }
    }
  });

  // 开始观察DOM变化
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// 页面加载时创建 UI 元素
function initializeUI() {
  console.log("Initializing UI. Document ready state:", document.readyState);
  console.log("Document body exists:", !!document.body);
  
  if (!document.body) {
    console.log("Document body not ready, waiting...");
    setTimeout(initializeUI, 100);
    return;
  }
  
  console.log("Creating popup and floating button...");
  createPopup();
  floatingControlBtn = createFloatingButton();
  console.log("Floating button created:", floatingControlBtn);
}

// 确保DOM准备就绪后再初始化UI
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeUI);
} else {
  initializeUI();
}

// 启动视频检测
setupVideoDetection();

// 添加视频位置变化监听器
function setupFloatingButtonRepositioning() {
  // 当窗口大小变化或滚动时，如果没有保存的自定义位置，重新定位到视频左上角
  function repositionIfNeeded() {
    if (floatingControlBtn) {
      // 检查是否使用的是默认位置（没有保存的自定义位置）
      chrome.storage.local.get(["floatingBtnPos"], (result) => {
        if (!result.floatingBtnPos) {
          // 只有在没有自定义位置时才重新定位
          setDefaultFloatingButtonPosition(floatingControlBtn);
        }
      });
    }
  }
  
  // 监听窗口大小变化
  window.addEventListener('resize', repositionIfNeeded);
  
  // 监听滚动事件（节流处理）
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(repositionIfNeeded, 100);
  });
  
  console.log("Floating button repositioning listeners added");
}

setupFloatingButtonRepositioning();

// 创建字幕栏元素
// 定位字幕栏函数
function positionSubtitleBar() {
  // 确保 subtitleBar 和 video 变量在此作用域可用
  if (video && subtitleBar) {
    // 检测是否处于全屏状态
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || 
                            document.mozFullScreenElement || document.msFullscreenElement);
    
    console.log(`定位字幕栏 - 全屏状态: ${isFullscreen}`);
    
    if (isFullscreen) {
      // 全屏模式：确保字幕栏被添加到全屏元素中
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || 
                               document.mozFullScreenElement || document.msFullscreenElement;
      
      if (fullscreenElement && subtitleBar.parentNode !== fullscreenElement) {
        // 将字幕栏移动到全屏元素中
        fullscreenElement.appendChild(subtitleBar);
        console.log('字幕栏已移动到全屏元素中');
      }
      
      // 全屏模式：调整z-index确保字幕在全屏视频上方显示
      subtitleBar.style.position = "absolute";
      subtitleBar.style.zIndex = "999999";
      
      // 全屏时，将字幕栏定位在屏幕底部上方200px位置 (原为50px)
      const subtitleBarHeight = subtitleBar.offsetHeight || 100;
      subtitleBar.style.top = `${window.innerHeight - 200 - subtitleBarHeight}px`;
      
      // 全屏时字幕栏宽度为屏幕宽度的90%
      const subtitleBarWidth = window.innerWidth * 0.9;
      const left = (window.innerWidth - subtitleBarWidth) / 2;
      
      subtitleBar.style.width = `${subtitleBarWidth}px`;
      subtitleBar.style.left = `${left}px`;
      
      console.log(`全屏模式字幕栏定位: 宽度=${subtitleBarWidth}px, 左边距=${left}px, 顶部=${subtitleBar.style.top}`);
    } else {
      // 退出全屏时，将字幕栏移回视频的父容器
      const videoParent = video.parentElement || document.body;
      if (subtitleBar.parentNode !== videoParent) {
        videoParent.appendChild(subtitleBar);
        console.log('字幕栏已移回视频父容器');
      }
      
      // 普通模式：相对于视频位置定位
      subtitleBar.style.position = "fixed";
      subtitleBar.style.zIndex = "9998";
      
      const videoRect = video.getBoundingClientRect();
      
      // 设置垂直位置：在视频底部上方200px处 (原为50px)
      const subtitleBarHeight = subtitleBar.offsetHeight || 100;
      subtitleBar.style.top = `${videoRect.bottom - 200 - subtitleBarHeight}px`;

      // 设置水平位置：相对视频宽度居中，宽度为视频宽度的90%
      const subtitleBarWidth = videoRect.width * 0.9;
      const left = videoRect.left + (videoRect.width - subtitleBarWidth) / 2;

      subtitleBar.style.width = `${subtitleBarWidth}px`;
      subtitleBar.style.left = `${left}px`;
      
      console.log(`普通模式字幕栏定位: 宽度=${subtitleBarWidth}px, 左边距=${left}px, 顶部=${subtitleBar.style.top}`);
    }
    
    subtitleBar.style.transform = "none"; // 移除之前的transform
    subtitleBar.style.bottom = "auto"; // 清除bottom属性
  }
}
function createSubtitleBar() {
  const subtitleBar = document.createElement("div");
  subtitleBar.id = "subtitle-sync-bar";
  subtitleBar.style.position = "fixed";
  subtitleBar.style.zIndex = "9998";
  subtitleBar.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
  subtitleBar.style.color = "white";
  subtitleBar.style.padding = "10px";
  subtitleBar.style.borderRadius = "5px";
  subtitleBar.style.fontFamily = "Arial, sans-serif";
  subtitleBar.style.width = "auto"; // 初始宽度设为auto，由positionSubtitleBar函数动态设置
  subtitleBar.style.maxWidth = "none"; // 移除最大宽度限制
  subtitleBar.style.minWidth = "300px";
  subtitleBar.style.display = "grid";
  subtitleBar.style.gridTemplateRows = "auto auto auto";
  subtitleBar.style.gap = "5px";
  subtitleBar.style.cursor = "move";
  subtitleBar.style.userSelect = "none";

  // 阻止字幕栏上的点击事件冒泡到视频，防止拖动字幕栏时暂停视频
  subtitleBar.addEventListener('click', function(event) {
    event.stopPropagation();
  });

  // 第一行 - 播放速度和重置按钮
  const speedRow = document.createElement("div");
  speedRow.style.display = "flex";
  speedRow.style.justifyContent = "space-between";
  speedRow.style.alignItems = "center";

  // ----------- 新增倍速调节按钮 -----------

  const speedText = document.createElement("span");
  speedText.id = "subtitle-speed";
  speedText.textContent = "速度: 1.0x";

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "重置位置";
  resetBtn.style.padding = "2px 8px";
  resetBtn.style.border = "1px solid white";
  resetBtn.style.borderRadius = "3px";
  resetBtn.style.backgroundColor = "transparent";
  resetBtn.style.color = "white";
  resetBtn.style.cursor = "pointer";

  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "清空缓存";
  refreshBtn.style.padding = "2px 8px";
  refreshBtn.style.border = "1px solid white";
  refreshBtn.style.borderRadius = "3px";
  refreshBtn.style.backgroundColor = "transparent";
  refreshBtn.style.color = "white";
  refreshBtn.style.cursor = "pointer";
  // 隐藏清空缓存按钮
  refreshBtn.style.display = "none";
  // 倍速显示加入 speedRow
  speedRow.appendChild(speedText);

  // ----------- 倍速调节逻辑 -----------
  // 默认初始速度
  let currentSpeed = 1.0;
  // 设置允许的最小和最大倍速
  const minSpeed = 0.5;
  const maxSpeed = 3.0;
  const speedStep = 0.1;

  // 中文注释：应用倍速到视频元素
  function applyVideoSpeed(speed) {
    if (video) {
      video.playbackRate = speed;
      speedText.textContent = `速度: ${speed.toFixed(1)}x`;
    }
  }

  // 初始化时同步 video 元素的实际倍速
  if (video) {
    currentSpeed = video.playbackRate || 1.0;
    speedText.textContent = `速度: ${currentSpeed.toFixed(1)}x`;
  }

  // 监听 video 的 ratechange，保持 UI 显示同步
  if (video) {
    video.addEventListener("ratechange", () => {
      currentSpeed = video.playbackRate;
      speedText.textContent = `速度: ${currentSpeed.toFixed(1)}x`;
    });
  }

  // 第二、三行 - 字幕内容
  const subtitleLine1 = document.createElement("div");
  subtitleLine1.id = "subtitle-line1";
  subtitleLine1.style.textAlign = "center";
  subtitleLine1.style.fontSize = "3em"; // 字体大小扩大0.5倍 (原为2em)

  const subtitleLine2 = document.createElement("div");
  subtitleLine2.id = "subtitle-line2";
  subtitleLine2.style.textAlign = "center";
  subtitleLine2.style.fontSize = "3em"; // 字体大小扩大0.5倍 (假设与第一行一致)

  subtitleBar.appendChild(speedRow);
  subtitleBar.appendChild(subtitleLine1);
  subtitleBar.appendChild(subtitleLine2);

  // 拖动功能
  let isDragging = false;
  let offsetX, offsetY;

  subtitleBar.addEventListener("mousedown", (e) => {
    if (e.target === resetBtn) return; // 不拦截重置按钮的点击
    isDragging = true;
    const rect = subtitleBar.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    let newLeft = e.clientX - offsetX;
    let newTop = e.clientY - offsetY;

    // 边界检查
    const maxLeft = window.innerWidth - subtitleBar.offsetWidth;
    const maxTop = window.innerHeight - subtitleBar.offsetHeight;

    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    newTop = Math.max(0, Math.min(newTop, maxTop));

    subtitleBar.style.left = `${newLeft}px`;
    subtitleBar.style.top = `${newTop}px`;
    subtitleBar.style.bottom = "auto";
    subtitleBar.style.transform = "none";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // 重置位置功能
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    positionSubtitleBar();
  });

  // 重新获取音频功能 - 强制从接口获取(不使用缓存)
  refreshBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const currentText =
      shadowRoot?.getElementById("current-subtitle")?.textContent;
    if (currentText && currentText !== "") {
      chrome.runtime.sendMessage(
        {
          action: "callGPTSoVITS",
          text: currentText,
          language: currentLanguage,
          noCache: true, // 强制重新调用接口
          timestamp: Date.now(), // 添加时间戳防止缓存
        },
        (response) => {
          if (response?.audioBase64) {
            playAudio(response.audioBase64);
          } else if (response?.error) {
            console.error("重新获取音频失败:", response.error);
          }
        }
      );
    }
  });

  // 重新获取音频功能
  refreshBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const currentText =
      shadowRoot?.getElementById("current-subtitle")?.textContent;
    if (currentText && currentText !== "") {
      chrome.runtime.sendMessage(
        {
          action: "callGPTSoVITS",
          text: currentText,
          language: currentLanguage, // 假设已定义当前语言变量
        },
        (response) => {
          if (response?.audioBase64) {
            playAudio(response.audioBase64); // 假设已有playAudio函数
          } else if (response?.error) {
            console.error("重新获取音频失败:", response.error);
          }
        }
      );
    }
  });

  document.body.appendChild(subtitleBar);
  
  // 立即检查是否处于全屏状态，如果是则移动到全屏元素中
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || 
                          document.mozFullScreenElement || document.msFullscreenElement);
  if (isFullscreen) {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || 
                             document.mozFullScreenElement || document.msFullscreenElement;
    if (fullscreenElement) {
      fullscreenElement.appendChild(subtitleBar);
      console.log('字幕栏创建时即移动到全屏元素中');
    }
  }
  
  // 添加全屏状态变化监听器
  const fullscreenEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
  fullscreenEvents.forEach(eventName => {
    document.addEventListener(eventName, () => {
      console.log('全屏状态变化，重新定位字幕栏');
      // 延迟执行以确保全屏转换完成
      setTimeout(() => {
        positionSubtitleBar();
      }, 100);
    });
  });
  
  positionSubtitleBar();
  
  // 检查隐藏字幕栏的状态
  setTimeout(() => {
    const hideSubtitleBarBtn = shadowRoot?.getElementById("hide-subtitle-bar");
    if (hideSubtitleBarBtn && hideSubtitleBarBtn.checked && subtitleBar) {
      subtitleBar.style.display = "none";
    }
  }, 100);
  
  return subtitleBar;
}

// 创建注入的Popup Div
/**
 * 创建 popupDiv，并根据 chrome.storage.local 的 popupVisible 状态初始化显示/隐藏
 */
function createPopup() {
  popupDiv = document.createElement("div");
  popupDiv.id = "subtitle-sync-popup";
  popupDiv.style.position = "fixed";
  popupDiv.style.zIndex = "9999";
  popupDiv.style.backgroundColor = "#f5f5f5";
  popupDiv.style.border = "1px solid #ccc";
  popupDiv.style.borderRadius = "5px";
  popupDiv.style.boxShadow = "0 2px 10px rgba(0,0,0,0.2)";
  popupDiv.style.width = "400px";
  popupDiv.style.height = "500px";
  popupDiv.style.overflow = "hidden"; // 防止内容溢出影响拖拽
  popupDiv.style.display = "none"; // 初始隐藏所有UI元素

  document.body.appendChild(popupDiv);

  // Positioning is now handled by positionPopupRelativeToFloatingButton()
  // called from createFloatingButton() or its event listeners.

  // 使用 Shadow DOM 隔离样式
  shadowRoot = popupDiv.attachShadow({ mode: "open" });

  // 注入 HTML 和 CSS
  shadowRoot.innerHTML = `
    <style>
      :host { /* 应用于 Shadow DOM 根元素 */
        display: flex;
        flex-direction: column;
        height: 100%;
        box-sizing: border-box; /* 确保 padding 不会增加总尺寸 */
      }
      .container {
        padding: 10px;
        font-family: Arial, sans-serif;
        background-color: #f5f5f5;
        height: 100%;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 0;
        cursor: move; /* 添加拖拽光标 */
        user-select: none; /* 防止拖拽时选中文本 */
        
      }
      .controls {
        display: flex;
        gap: 10px;
        margin: 10px 0;
        align-items: center; /* 垂直居中容器内的所有项目 */
      }
      .checkbox-container { /* 新增：为复选框容器添加样式 */
        display: flex; /* 使用 flex 布局 */
        align-items: center; /* 垂直居中内部元素 */
        padding: 3px 8px; /* 添加一些内边距 */
        border-radius: 4px; /* 可选：添加圆角 */
        gap: 5px; /* 复选框和标签之间的间距 */
        width: 100%; /* 使其占据父容器全部宽度 */
        box-sizing: border-box; /* 确保 padding 不会影响总宽度 */
      }
      .help-icon { /* 新增：帮助图标样式 */
        cursor: help;
        font-size: 0.9em;
        color: #666;
        margin-left: 5px; /* 与前面的标签保持距离 */
      }
      button {
        cursor: pointer;
        color:white;
        background-color: black;
        border: none;
        border-radius: 4px;
        text-size: 5em;
        padding: 5px 10px;
      }
      .current-subtitle {
        padding: 10px;
        margin: 10px 0;
        background-color: #fff;
        border-radius: 4px;
        min-height: 50px;
        border: 1px solid #eee;
        overflow-y: auto; /* 如果文本过长则滚动 */
        max-height: 80px; /* 限制最大高度 */
      }
      .subtitle-list {
        flex-grow: 1; /* 占据剩余空间 */
        overflow-y: auto;
        border: 1px solid #eee;
        background-color: #fff;
        border-radius: 4px;
        margin-bottom: 10px; /* 底部留出空间 */
      }
      .subtitle-item {
        display: flex;
        justify-content: space-between;
        padding: 5px;
        border-bottom: 1px solid #eee;
      }
      .subtitle-text {
        flex: 1;
        margin-right: 10px; /* 与状态保持距离 */
        white-space: pre-wrap; /* 保留换行 */
      }
      .audio-status {
        width: 80px; /* 调整宽度 */
        text-align: right;
        font-size: 0.9em;
        color: #666;
        display: flex; /* 让按钮和文本在同一行 */
        justify-content: flex-end;
        align-items: center;
      }
      .play-single-audio {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1.1em;
        padding: 0 5px;
        line-height: 1;
        color: #007bff;
      }
      .play-single-audio:hover {
        color: #0056b3;
      }
      .subtitle-item.highlight {
        background-color: #e9f5ff; /* 当前播放字幕高亮 */
      }
      /* Styles for list collapse */
      .list-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 5px 0;
        margin-top: 10px;
        border-bottom: 1px solid #eee; /* Optional separator */
        margin-bottom: 5px; /* Space below header */
      }
      .list-header h4 {
        margin: 0;
        font-size: 1em;
        font-weight: bold;
      }
      #toggle-list-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1.2em;
        padding: 0 5px;
        line-height: 1;
      }
      .subtitle-list.collapsed {
        display: none;
      }
    </style>
    <div class="container">
      <div class="header">
        <h3 style="margin:0;">设置</h3>
      </div>
      <div class="controls">
        <button id="select-file">选择字幕文件</button>
        
        <button id="play-audio-start">从头播放</button>
        <button id="select-voice-config">更新语音配置</button>
        <button id="batch-load-audio">加载音频</button>
        <button id="stop-batch-load" style="display: none; background-color: #ff4444; color: white;">停止加载</button>
        
        <input type="file" id="voice-config-input" accept=".txt" style="display: none;">
      </div>
      <div class="controls" style="padding: 0px;">
      <select id="voice-select" style="min-width: 120px;" style="width: 150px;">
          <option value="">选择语音</option>
        </select> 
        </div>
      <div class="checkbox-container"> <!-- 添加类名 -->
               <input type="checkbox" id="myCheckbox" name="myCheckbox">
               <label for="myCheckbox">重新生成音频</label>
               <span class="help-icon" title="勾选后,将忽略浏览器中已有的字幕音频缓存,重新生成音频">(?)</span>
             </div>
              <div class="checkbox-container"> <!-- 添加类名 -->
               <input type="checkbox" id="learn" name="learn">
               <label for="learn">跟读模式</label>
               <span class="help-icon" title="勾选后,将不再同步播放视频画面和字幕音频\n而是先播放字幕音频,然后播放原声,方便学习语言">(?)</span>
             </div>
             <div class="checkbox-container"> <!-- 新增：隐藏字幕栏选项 -->
               <input type="checkbox" id="hide-subtitle-bar" name="hide-subtitle-bar">
               <label for="hide-subtitle-bar">隐藏字幕栏</label>
               <span class="help-icon" title="勾选后,将隐藏视频上方的字幕栏显示">(?)</span>
             </div>
             <div class="checkbox-container"> <!-- 新增：静音选项 -->
              <input type="checkbox" id="mute-audio" name="mute-audio">
              <label for="mute-audio">静音</label>
              <span class="help-icon" title="勾选后,将静音生成的音频">(?)</span>
            </div>
      <div class="current-subtitle" id="current-subtitle"></div>
      <div class="list-header">
        <h4>字幕列表</h4>
        <button id="toggle-list-btn" title="展开/收起列表">⬆️</button>
      </div>
      <div class="subtitle-list" id="subtitle-list">
        <!-- 字幕列表将在这里动态生成 -->
      </div>
      <input type="file" id="file-input" accept=".srt,.vtt" style="display: none;">
    </div>
  `;

  // 获取 Shadow DOM 内的元素
  const selectFileBtn = shadowRoot.getElementById("select-file");
  const header = shadowRoot.querySelector(".header");
  const fileInput = shadowRoot.getElementById("file-input"); // 获取文件输入元素
  const subtitleListEl = shadowRoot.getElementById("subtitle-list"); // 获取字幕列表元素
  const toggleListBtn = shadowRoot.getElementById("toggle-list-btn"); // 获取折叠按钮
  const voiceSelect = shadowRoot.getElementById("voice-select"); // 获取语音选择下拉框
  const voiceConfigBtn = shadowRoot.getElementById("select-voice-config"); // 获取语音配置按钮
  const voiceConfigInput = shadowRoot.getElementById("voice-config-input"); // 获取语音配置文件输入
  const muteAudioCheckbox = shadowRoot.getElementById("mute-audio"); // 获取静音复选框

  // 处理选择语音配置文件按钮点击
  voiceConfigBtn.addEventListener("click", () => {
    voiceConfigInput.click();
  });

  // 处理语音配置文件的加载
  voiceConfigInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // 在加载新的txt文件时，清除现有的音频缓存和配置
        chrome.storage.local.get(null, (items) => {
          const keysToRemove = Object.keys(items).filter(
            (key) =>
              key.startsWith("audio_") ||
              key === "voiceConfig" ||
              key === "selectedVoice"
          );
          if (keysToRemove.length > 0) {
            chrome.storage.local.remove(keysToRemove, () => {
              console.log("Cleared previous audio cache and voice config");
            });
          }
        });

        const content = e.target.result;
        const lines = content.split(/\r?\n/);
        const audioFiles = lines
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line.endsWith(".wav"));

        // 保存语音配置到 storage
        chrome.storage.local.set(
          {
            voiceConfig: audioFiles,
          },
          () => {
            console.log("Voice config saved to storage");
          }
        );

        // 清空现有选项
        voiceSelect.innerHTML = '<option value="">选择语音</option>';

        // 添加新选项
        audioFiles.forEach((fileName) => {
          const parts = fileName.split("-");
          if (parts.length >= 2) {
            const option = document.createElement("option");
            option.value = fileName;
            option.textContent = parts[1]; // 使用第一个'-'后面的文字作为显示名称
            voiceSelect.appendChild(option);
          }
        });
      } catch (error) {
        console.error("Error parsing voice config file:", error);
        alert("解析语音配置文件失败");
      }
    };
    reader.readAsText(file);
    voiceConfigInput.value = ""; // 重置input以便可以再次选择同一文件
  });

  // 处理语音选择变化
  voiceSelect.addEventListener("change", function () {
    const selectedFile = this.value;
    if (selectedFile) {
      const selectedOption = this.options[this.selectedIndex];
      const parts = selectedFile.split("-");
      if (parts.length >= 3) {
        // 更新GPTSoVITS请求参数
        const ref_audio_path = "/Users/apple/Downloads/bhys/" + selectedFile;
        const prompt_text = parts[2].replace(".wav", "");
        const voiceParams = {
          ref_audio_path,
          prompt_text,
        };

        // 存储选中的语音配置到 storage
        chrome.storage.local.set(
          {
            selectedVoice: {
              file: selectedFile,
              params: voiceParams,
            },
          },
          () => {
            console.log("Selected voice saved to storage");
          }
        );

        // 更新全局变量
        window.gptsoVitsParams = voiceParams;
      }
    }
  });
  const isReloadBtn = shadowRoot.getElementById("myCheckbox"); // 从 shadowRoot 获取
  const isLearnBtn = shadowRoot.getElementById("learn"); // 从 shadowRoot 获取
  const hideSubtitleBarBtn = shadowRoot.getElementById("hide-subtitle-bar"); // 获取隐藏字幕栏复选框
  const playAudioStartBtn = shadowRoot.getElementById("play-audio-start"); // 获取从头播放按钮
  const batchLoadAudioBtn = shadowRoot.getElementById("batch-load-audio"); // 获取批量加载音频按钮
  const stopBatchLoadBtn = shadowRoot.getElementById("stop-batch-load"); // 获取停止批量加载按钮
  const helpIcons = shadowRoot.querySelectorAll(".help-icon"); // 获取所有帮助图标

  // 从storage加载语音配置
  function loadVoiceConfig() {
    chrome.storage.local.get(["voiceConfig", "selectedVoice"], (result) => {
      if (result.voiceConfig) {
        // 更新语音选择下拉框
        voiceSelect.innerHTML = '<option value="">选择语音</option>';
        result.voiceConfig.forEach((fileName) => {
          const parts = fileName.split("-");
          if (parts.length >= 2) {
            const option = document.createElement("option");
            option.value = fileName;
            option.textContent = parts[1];
            voiceSelect.appendChild(option);
          }
        });

        // 如果有已选择的语音，恢复选择
        if (result.selectedVoice) {
          voiceSelect.value = result.selectedVoice.file;
          window.gptsoVitsParams = result.selectedVoice.params;
        }
      }
    });
  }

  // 初始化加载语音配置
  loadVoiceConfig();

  // 初始化复选框状态
  function loadCheckboxStates() {
    if (isReloadBtn) {
      isReload = false;
      isReloadBtn.checked = false;
    }
    if (isLearnBtn) {
      isLearn = false;
      isLearnBtn.checked = false;
    }
    // 加载静音复选框状态
    chrome.storage.local.get(["isMuted"], (result) => {
      if (muteAudioCheckbox) {
        muteAudioCheckbox.checked = result.isMuted || false;
        // 根据存储的值更新实际的静音状态变量
        isMuted = result.isMuted || false; 
      }
    });
  }

  // Call after shadowRoot elements are available
  if (shadowRoot) {
    loadCheckboxStates();
  } else {
    // Fallback if shadowRoot is not immediately available (should be, but as a safeguard)
    const observer = new MutationObserver((mutationsList, obs) => {
      if (popupDiv && popupDiv.shadowRoot) {
        shadowRoot = popupDiv.shadowRoot; // Ensure global shadowRoot is updated if it wasn't
        // Re-fetch buttons if they weren't available when loadCheckboxStates was first attempted
        // This is a bit redundant if createPopup guarantees shadowRoot elements are queryable before returning
        // but acts as a safeguard.
        // isReloadBtn = shadowRoot.getElementById("myCheckbox");
        // isLearnBtn = shadowRoot.getElementById("learn");
        loadCheckboxStates();
        obs.disconnect(); // Stop observing once done
      }
    });
    observer.observe(document.body, { childList: true, subtree: true }); // Observe for popupDiv to be added
  }

  if (isReloadBtn) {
    isReloadBtn.addEventListener("change", function () {
      isReload = this.checked;
      // 在切换重新生成开关时，重置音频状态
      if (isReload) {
        subtitles.forEach((sub) => {
          sub.audioStatus = "unloaded";
          sub.audioUrl = null;
          sub.audioDuration = null;
          sub.playbackRate = null;
        });
        renderSubtitleList();
      }
    });
  }

  if (isLearnBtn) {
    isLearnBtn.addEventListener("change", function () {
      isLearn = this.checked;
    });
  }

  // 静音复选框事件监听器
  if (muteAudioCheckbox) {
    muteAudioCheckbox.addEventListener("change", function () {
      isMuted = this.checked;
      chrome.storage.local.set({ isMuted: isMuted });
      if (isMuted && currentAudio) {
        stopCurrentAudio(); // 如果勾选静音且有音频在播放，则停止
      }
    });
  }

  // 隐藏字幕栏复选框事件监听器
  if (hideSubtitleBarBtn) {
    hideSubtitleBarBtn.addEventListener("change", function () {
      if (subtitleBar) {
        if (this.checked) {
          subtitleBar.style.display = "none";
          console.log("字幕栏已隐藏");
        } else {
          subtitleBar.style.display = "grid";
          console.log("字幕栏已显示");
        }
      }
    });
  }

  // 选择字幕文件 - 点击按钮触发隐藏的 input
  selectFileBtn.addEventListener("click", () => {
    fileInput.click(); // 触发文件选择对话框
  });

  // 文件选择后的处理
  fileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) {
      console.log("No file selected.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      try {
        subtitles = parseSubtitleFile(content);
        renderSubtitleList(); // 渲染列表，显示“未加载”

        if (playAudioStartBtn) {
          playAudioStartBtn.disabled = subtitles.length === 0; // 如果有字幕则启用，否则禁用
        }

        // 文件选择成功后，重置播放状态
        stopCurrentAudio();
        if (video) video.pause(); // 暂停视频
        console.log("Subtitles loaded, starting audio fetch.");
      } catch (error) {
        console.error("Error parsing subtitle file:", error);
        alert("解析字幕文件失败: " + error.message);
      } finally {
        // 重置文件输入，以便用户可以再次选择相同的文件
        fileInput.value = "";
      }
    };
    reader.onerror = (e) => {
      console.error("Error reading file:", e);
      alert("读取文件失败");
      // 重置文件输入
      fileInput.value = "";
    };
    reader.readAsText(file); // 以文本形式读取文件
  });

  // 播放/暂停控制 (直接控制页面视频)

  // 事件委托处理单句播放按钮点击
  subtitleListEl.addEventListener("click", (event) => {
    if (event.target.classList.contains("play-single-audio")) {
      const subtitleId = event.target.dataset.id;
      const subtitle = subtitles.find((sub) => sub.id === subtitleId);
      if (subtitle && subtitle.audioStatus === "loaded" && subtitle.audioUrl) {
        console.log(`Playing single audio for subtitle: ${subtitleId}`);
        // 停止主播放状态
        // 已移除主播放按钮相关逻辑
        stopCurrentAudio(); // 停止任何正在播放的音频
        if (video) {
          video.currentTime = subtitle.startTime; // 跳转视频时间
        }
        playAudio(subtitle.audioUrl, subtitle.id, true); // true 表示是单句播放
      }
    }
  });

  // 为帮助图标添加点击事件监听器
  helpIcons.forEach((icon) => {
    icon.addEventListener("click", (event) => {
      // 确保事件目标是 span.help-icon 本身，而不是其子元素（如果将来有的话）
      const targetIcon = event.currentTarget;
      const helpText = targetIcon.getAttribute("title");
      if (helpText) {
        alert(helpText); // 使用 alert 显示帮助文本
      }
    });
  });

  // 折叠/展开字幕列表按钮
  toggleListBtn.addEventListener("click", () => {
    subtitleListEl.classList.toggle("collapsed");
    if (subtitleListEl.classList.contains("collapsed")) {
      toggleListBtn.textContent = "⬇️";
      toggleListBtn.title = "展开列表";
    } else {
      toggleListBtn.textContent = "⬆️";
      toggleListBtn.title = "收起列表";
    }
  });

  // 从头播放按钮点击事件
  if (playAudioStartBtn) {
    // 确保按钮元素存在
    playAudioStartBtn.addEventListener("click", () => {
      if (playAudioStartBtn.disabled) return; // 如果按钮是禁用的，则不执行操作

      // 若勾选“重新生成音频”，则重置所有字幕音频的获取状态
      if (isReloadBtn && isReloadBtn.checked) {
        subtitles.forEach((sub) => {
          sub.audioStatus = "unloaded";
          sub.audioUrl = null;
          sub.audioDuration = null;
          sub.playbackRate = null;
        });
        // 重新渲染字幕列表状态
        if (typeof renderSubtitleList === "function") {
          renderSubtitleList();
        }
      }

      // 动态获取当前视频元素
      const currentVideo = video || findVideoElement();
      
      if (currentVideo) {
        console.log("执行从头播放操作");
        currentVideo.currentTime = 0; // 将视频进度设置为 0
        if (currentVideo.paused) {
          // 如果视频已暂停
          currentVideo.play().then(() => {
            console.log("视频开始播放");
          }).catch((error) => {
            console.error("视频播放失败:", error);
          });
        }
        console.log("视频时间已设置为0，当前时间:", currentVideo.currentTime);
      } else {
        console.warn("未找到视频元素，无法执行从头播放");
      }
      
      stopCurrentAudio(); // 停止可能正在播放的字幕音频
      lastPlayedSubtitleId = null; // 重置上次播放ID，确保从头开始同步
    });
  } else {
    console.error("未能从 Shadow DOM 中找到 ID 为 'play-audio-start' 的按钮。");
  }

  // 批量加载音频按钮点击事件
  if (batchLoadAudioBtn) {
    batchLoadAudioBtn.addEventListener("click", () => {
      if (subtitles.length === 0) {
        alert("请先选择字幕文件");
        return;
      }
      
      if (batchLoadingInProgress) {
        alert("批量加载正在进行中，请等待或点击停止按钮");
        return;
      }
      
      // 重置取消标志
      batchLoadingCanceled = false;
      window.batchLoadingCanceled = false;
      batchLoadingInProgress = true;
      window.batchLoadingInProgress = true;
      
      // 更新UI状态
      batchLoadAudioBtn.disabled = true;
      batchLoadAudioBtn.textContent = "加载中...";
      batchLoadAudioBtn.style.display = "none";
      if (stopBatchLoadBtn) {
        stopBatchLoadBtn.style.display = "inline-block";
      }
      
      batchLoadAllAudios().then(() => {
        // 加载完成，恢复UI状态
        batchLoadingInProgress = false;
        batchLoadAudioBtn.disabled = false;
        batchLoadAudioBtn.textContent = "加载音频";
        batchLoadAudioBtn.style.display = "inline-block";
        if (stopBatchLoadBtn) {
          stopBatchLoadBtn.style.display = "none";
        }
        
        if (batchLoadingCanceled) {
          console.log("批量加载已被用户取消");
        } else {
          console.log("所有音频加载完成");
        }
      }).catch((error) => {
        // 加载出错，恢复UI状态
        batchLoadingInProgress = false;
        batchLoadAudioBtn.disabled = false;
        batchLoadAudioBtn.textContent = "加载音频";
        batchLoadAudioBtn.style.display = "inline-block";
        if (stopBatchLoadBtn) {
          stopBatchLoadBtn.style.display = "none";
        }
        console.error("批量加载音频出错:", error);
        alert("批量加载音频过程中出现错误");
      });
    });
  }

  // 停止批量加载按钮点击事件
  if (stopBatchLoadBtn) {
    stopBatchLoadBtn.addEventListener("click", () => {
      if (batchLoadingInProgress) {
        batchLoadingCanceled = true;
        console.log("用户请求停止批量加载");
        
        // 立即更新UI状态
        batchLoadingInProgress = false;
        batchLoadAudioBtn.disabled = false;
        batchLoadAudioBtn.textContent = "加载音频";
        batchLoadAudioBtn.style.display = "inline-block";
        stopBatchLoadBtn.style.display = "none";
        
        alert("批量加载已停止");
      }
    });
  }

  // --- 实现拖拽功能 ---
  let isDragging = false;
  let offsetX, offsetY;

  header.addEventListener("mousedown", (e) => {
    // 确保只在 header 上按下鼠标左键时触发拖拽
    if (e.button !== 0) return;
    isDragging = true;
    // 计算鼠标指针相对于 popupDiv 左上角的偏移量
    const rect = popupDiv.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    // 阻止默认的文本选择行为
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    // 计算新的 top 和 left 值
    let newTop = e.clientY - offsetY;
    let newLeft = e.clientX - offsetX;

    // 边界检查，防止拖出视窗
    const maxTop = window.innerHeight - popupDiv.offsetHeight;
    const maxLeft = window.innerWidth - popupDiv.offsetWidth;

    newTop = Math.max(0, Math.min(newTop, maxTop));
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));

    popupDiv.style.top = `${newTop}px`;
    popupDiv.style.left = newLeft + "px"; // 修改 left 属性
    popupDiv.style.right = "auto"; // 清除 right 属性，避免冲突
  });

  document.addEventListener("mouseup", (e) => {
    // 确保只在鼠标左键抬起时停止拖拽
    if (e.button !== 0) return;
    if (isDragging) {
      isDragging = false;
    }
  });

  // 初始渲染一次字幕列表（如果已有字幕数据）
  if (subtitles.length > 0) {
    renderSubtitleList();
  }
}

// --- 从 popup.js 迁移过来的函数 ---

// 解析字幕文件 (SRT)
function parseSubtitleFile(content) {
  const lines = content.split(/\r?\n/); // 处理不同系统的换行符
  const result = [];
  let currentSub = null;
  let state = 0; // 0: 序号, 1: 时间, 2: 文本

  lines.forEach((line) => {
    line = line.trim();
    if (!line) {
      if (state === 2 && currentSub && currentSub.text) {
        // 确保有文本才算结束
        result.push(currentSub);
        currentSub = null;
        state = 0;
      }
      return; // 跳过空行
    }

    switch (state) {
      case 0: // 期待序号
        if (line.match(/^\d+$/)) {
          // 初始化字幕对象，增加 audioStatus 和 audioUrl
          currentSub = {
            id: line,
            text: "",
            startTime: 0, // 添加默认值
            endTime: 0, // 添加默认值
            audioStatus: "unloaded", // 'unloaded', 'loading', 'loaded', 'failed'
            audioUrl: null,
            audioDuration: null, // 用于存储实际音频时长
            playbackRate: null, // 用于存储计算的播放速率
          };
          state = 1;
        }
        break;
      case 1: // 期待时间轴
        const timeMatch = line.match(
          /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
        );
        if (timeMatch && currentSub) {
          currentSub.startTime = parseTime(timeMatch[1]);
          currentSub.endTime = parseTime(timeMatch[2]);
          state = 2;
        } else {
          // 时间格式不匹配，重置状态
          currentSub = null;
          state = 0;
        }
        break;
      case 2: // 期待文本
        if (currentSub) {
          currentSub.text += (currentSub.text ? "\n" : "") + line;
          // 文本可以有多行，继续状态2，直到遇到空行
        }
        break;
    }
  });

  // 处理文件末尾没有空行的情况
  if (state === 2 && currentSub && currentSub.text) {
    result.push(currentSub);
  }

  // 字幕处理函数 - 已移除中文字幕合并优化逻辑
  function optimizeSubtitles(subs) {
    // 仅保留重新编号逻辑
    subs.forEach((sub, idx) => {
      sub.id = (idx + 1).toString();
    });
    return subs;
  }

  optimizeSubtitles(result);

  console.log("Parsed subtitles:", result); // 调试输出
  return result;
}

// 解析时间格式 H:M:S,ms
function parseTime(timeStr) {
  const parts = timeStr.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (parts) {
    const hours = parseInt(parts[1], 10);
    const minutes = parseInt(parts[2], 10);
    const seconds = parseInt(parts[3], 10);
    const milliseconds = parseInt(parts[4], 10);
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }
  return 0; // 解析失败返回0
}

// 渲染字幕列表
function renderSubtitleList() {
  if (!shadowRoot) return; // 确保 Shadow DOM 已创建
  const subtitleListEl = shadowRoot.getElementById("subtitle-list");
  if (!subtitleListEl) return; // 确保元素存在

  subtitleListEl.innerHTML = ""; // 清空列表
  subtitles.forEach((sub) => {
    const item = document.createElement("div");
    item.className = "subtitle-item";
    item.dataset.id = sub.id; // 给列表项也加上 ID，方便高亮

    // 使用 textContent 防止 XSS
    const textDiv = document.createElement("div");
    textDiv.className = "subtitle-text";
    textDiv.textContent = sub.text.trim();

    const statusDiv = document.createElement("div");
    statusDiv.className = "audio-status";
    statusDiv.dataset.id = sub.id; // 用于后续更新状态

    // 单句播放按钮
    const playBtn = document.createElement("button");
    playBtn.className = "play-single-audio";
    playBtn.textContent = "▶";
    playBtn.title = "播放本句音频";
    playBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      // 懒加载：如果音频未加载，先加载再播放
      if (sub.audioStatus === "unloaded") {
        await loadAudio(sub);
      }
      // 加载后再播放
      if (sub.audioUrl) {
        playAudio(sub.audioUrl, sub.id, true);
      }
    });

    // 根据初始状态渲染
    updateSubtitleStatusElement(statusDiv, sub.audioStatus, sub.id);

    statusDiv.appendChild(playBtn);
    item.appendChild(textDiv);
    item.appendChild(statusDiv);
    subtitleListEl.appendChild(item);
  });
}

// 更新当前字幕显示
function updateCurrentSubtitleDisplay(text) {
  if (!shadowRoot && !subtitleBar) return;

  // 更新Popup中的字幕
  if (shadowRoot) {
    const currentSubtitleEl = shadowRoot.getElementById("current-subtitle");
    if (currentSubtitleEl) {
      currentSubtitleEl.textContent = text || "";
    }
  }

  // 更新字幕栏中的字幕
  if (subtitleBar) {
    const lines = (text || "").split("\n");
    const line1 = subtitleBar.querySelector("#subtitle-line1");
    const line2 = subtitleBar.querySelector("#subtitle-line2");

    if (line1) line1.textContent = lines[0] || "";
    if (line2) line2.textContent = lines[1] || "";
  }
}

// --- 新增和修改的音频处理函数 ---

// 批量加载所有字幕的音频
async function batchLoadAllAudios() {
  console.log("开始批量加载音频，总数:", subtitles.length);
  
  // 筛选出需要加载的字幕
  const subtitlesToLoad = subtitles.filter(subtitle => {
    if (subtitle.audioStatus === "loaded" && !isReload) {
      console.log(`字幕 ${subtitle.id} 音频已存在，跳过`);
      return false;
    }
    return true;
  });
  
  console.log(`实际需要加载的音频数量: ${subtitlesToLoad.length}`);
  
  // 每批并发处理5个音频
  const batchSize = 5;
  const totalBatches = Math.ceil(subtitlesToLoad.length / batchSize);
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    // 检查是否被取消
    if (batchLoadingCanceled) {
      console.log(`批量加载在第 ${batchIndex + 1} 批时被取消`);
      throw new Error("批量加载被用户取消");
    }
    
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, subtitlesToLoad.length);
    const currentBatch = subtitlesToLoad.slice(startIndex, endIndex);
    
    console.log(`正在处理第 ${batchIndex + 1}/${totalBatches} 批，包含 ${currentBatch.length} 个音频`);
    
    // 并发加载当前批次的所有音频
    const batchPromises = currentBatch.map(async (subtitle, index) => {
      // 在每个音频加载前再次检查取消标志
      if (batchLoadingCanceled) {
        throw new Error("批量加载被用户取消");
      }
      
      const globalIndex = startIndex + index + 1;
      console.log(`正在加载第 ${globalIndex}/${subtitlesToLoad.length} 个音频: ${subtitle.id}`);
      
      try {
        await loadAudioAsync(subtitle);
        console.log(`字幕 ${subtitle.id} 音频加载完成`);
        return { success: true, id: subtitle.id };
      } catch (error) {
        console.error(`字幕 ${subtitle.id} 音频加载失败:`, error);
        return { success: false, id: subtitle.id, error };
      }
    });
    
    // 等待当前批次的所有音频加载完成
    const batchResults = await Promise.all(batchPromises);
    
    // 统计当前批次的结果
    const successCount = batchResults.filter(result => result.success).length;
    const failCount = batchResults.filter(result => !result.success).length;
    console.log(`第 ${batchIndex + 1} 批完成，成功: ${successCount}，失败: ${failCount}`);
    
    // 批次之间添加短暂延迟，避免服务器压力过大
    if (batchIndex < totalBatches - 1) {
      // 在延迟期间也检查取消标志
      await new Promise(resolve => {
        const timeoutId = setTimeout(() => {
          if (batchLoadingCanceled) {
            resolve();
          } else {
            resolve();
          }
        }, 200);
        
        // 如果被取消，立即解决Promise
        if (batchLoadingCanceled) {
          clearTimeout(timeoutId);
          resolve();
        }
      });
    }
  }
  
  console.log("批量加载音频完成");
}

// 将 loadAudio 函数包装为 Promise 版本，用于批量加载
function loadAudioAsync(subtitle) {
  return new Promise((resolve, reject) => {
    // 首先检查是否被取消
    if (batchLoadingCanceled) {
      reject(new Error("批量加载被用户取消"));
      return;
    }
    
    if (!subtitle) {
      reject(new Error("字幕对象为空"));
      return;
    }

    // 只有在音频未加载或强制重新生成时才进行加载
    if (subtitle.audioStatus !== "unloaded" && !isReload) {
      resolve();
      return;
    }

    subtitle.audioStatus = "loading";
    updateSubtitleStatusUI(subtitle.id, "loading");
    console.log(`Requesting audio for subtitle: ${subtitle.id}`);

    // 生成缓存key（用视频URL hash+字幕ID）
    function hashCode(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    }
    const videoKey =
      typeof location !== "undefined" ? hashCode(location.href) : 0;
    const cacheKey = `audio_${videoKey}_${subtitle.id}`;

    // 先尝试读取chrome.storage.local缓存
    chrome.storage.local.get([cacheKey], (result) => {
      // 在回调中再次检查是否被取消
      if (batchLoadingCanceled) {
        subtitle.audioStatus = "unloaded"; // 恢复状态
        updateSubtitleStatusUI(subtitle.id, "unloaded");
        reject(new Error("批量加载被用户取消"));
        return;
      }
      
      const cachedBase64 = result[cacheKey];
      if (
        cachedBase64 &&
        typeof cachedBase64 === "string" &&
        cachedBase64.length > 0 &&
        isReload === false // 仅在未勾选重新生成音频时使用缓存
      ) {
        // 命中缓存，直接用
        try {
          const audioBuffer = base64ToArrayBuffer(cachedBase64);
          const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
          const audioUrl = URL.createObjectURL(audioBlob);

          subtitle.audioStatus = "loaded";
          subtitle.audioUrl = audioUrl;

          // 计算音频时长并计算播放速率
          const tempAudio = new Audio(audioUrl);
          tempAudio.onloadedmetadata = () => {
            subtitle.audioDuration = tempAudio.duration;
            const subtitleDuration = Math.max(
              0.01,
              subtitle.endTime - subtitle.startTime
            );
            if (subtitle.audioDuration && subtitle.audioDuration > 0) {
              subtitle.playbackRate = subtitleDuration / subtitle.audioDuration;
            } else {
              subtitle.playbackRate = null;
            }
            updateSubtitleStatusUI(subtitle.id, "loaded");
            resolve();
          };
          tempAudio.onerror = () => {
            subtitle.audioDuration = null;
            subtitle.playbackRate = null;
            updateSubtitleStatusUI(subtitle.id, "loaded");
            resolve();
          };
        } catch (e) {
          console.error(
            `Error decoding cached Base64 or creating Blob/URL for subtitle ${subtitle.id}:`,
            e
          );
          subtitle.audioStatus = "failed";
          updateSubtitleStatusUI(subtitle.id, "failed");
          reject(e);
        }
      } else {
        // 未命中缓存，调用接口生成并保存到chrome.storage.local
        chrome.runtime.sendMessage(
          {
            action: "callGPTSoVITS",
            text: subtitle.text.trim(),
            language: "auto",
            noCache: isReload, // 添加 noCache 标志，其值等于 isReload 的当前状态
            ...(window.gptsoVitsParams || {}), // 添加已选择的语音参数
          },
          (response) => {
            // 在回调开始时检查是否被取消
            if (batchLoadingCanceled) {
              subtitle.audioStatus = "unloaded"; // 恢复状态
              updateSubtitleStatusUI(subtitle.id, "unloaded");
              reject(new Error("批量加载被用户取消"));
              return;
            }
            
            if (chrome.runtime.lastError || (response && response.error)) {
              console.error(
                `Error loading audio for ${subtitle.id} (detected lastError or response.error):`,
                chrome.runtime.lastError || response.error
              );
              subtitle.audioStatus = "failed";
              updateSubtitleStatusUI(subtitle.id, "failed");
              reject(new Error(chrome.runtime.lastError?.message || response.error));
            } else if (
              response &&
              typeof response.audioBase64 === "string" &&
              response.audioBase64.length > 0
            ) {
              // 保存到chrome.storage.local
              const saveObj = {};
              saveObj[cacheKey] = response.audioBase64;
              chrome.storage.local.set(saveObj, () => {
                if (chrome.runtime.lastError) {
                  console.warn(
                    `Failed to save audio to chrome.storage: ${cacheKey}`,
                    chrome.runtime.lastError.message
                  );
                } else {
                  console.log(`Audio saved to chrome.storage: ${cacheKey}`);
                }
              });
              // 正常流程
              try {
                const audioBuffer = base64ToArrayBuffer(response.audioBase64);
                const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
                const audioUrl = URL.createObjectURL(audioBlob);

                subtitle.audioStatus = "loaded";
                subtitle.audioUrl = audioUrl;

                // 计算音频时长并计算播放速率
                const tempAudio = new Audio(audioUrl);
                tempAudio.onloadedmetadata = () => {
                  subtitle.audioDuration = tempAudio.duration;
                  const subtitleDuration = Math.max(
                    0.01,
                    subtitle.endTime - subtitle.startTime
                  );
                  if (subtitle.audioDuration && subtitle.audioDuration > 0) {
                    subtitle.playbackRate =
                      subtitleDuration / subtitle.audioDuration;
                  } else {
                    subtitle.playbackRate = null;
                  }
                  updateSubtitleStatusUI(subtitle.id, "loaded");
                  resolve();
                };
                tempAudio.onerror = () => {
                  subtitle.audioDuration = null;
                  subtitle.playbackRate = null;
                  updateSubtitleStatusUI(subtitle.id, "loaded");
                  resolve();
                };
              } catch (e) {
                console.error(
                  `Error decoding Base64 or creating Blob/URL for subtitle ${subtitle.id}:`,
                  e
                );
                subtitle.audioStatus = "failed";
                updateSubtitleStatusUI(subtitle.id, "failed");
                reject(e);
              }
            } else {
              console.error(
                `Marking as failed due to invalid response (not error or valid Base64 string) for ${subtitle.id}. Full response logged above.`
              );
              subtitle.audioStatus = "failed";
              updateSubtitleStatusUI(subtitle.id, "failed");
              reject(new Error("Invalid response from audio generation service"));
            }
          }
        );
      }
    });
  });
}

// 加载单个字幕的音频
function loadAudio(subtitle) {
  if (!subtitle) return;

  // 只有在音频未加载或强制重新生成时才进行加载
  if (subtitle.audioStatus !== "unloaded" && !isReload) {
    return;
  }

  subtitle.audioStatus = "loading";
  updateSubtitleStatusUI(subtitle.id, "loading");
  console.log(`Requesting audio for subtitle: ${subtitle.id}`);

  // 生成缓存key（用视频URL hash+字幕ID）
  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
  const videoKey =
    typeof location !== "undefined" ? hashCode(location.href) : 0;
  const cacheKey = `audio_${videoKey}_${subtitle.id}`;

  // 先尝试读取chrome.storage.local缓存
  chrome.storage.local.get([cacheKey], (result) => {
    const cachedBase64 = result[cacheKey];
    if (
      cachedBase64 &&
      typeof cachedBase64 === "string" &&
      cachedBase64.length > 0 &&
      isReload === false // 仅在未勾选重新生成音频时使用缓存
    ) {
      // 命中缓存，直接用
      try {
        const audioBuffer = base64ToArrayBuffer(cachedBase64);
        const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
        const audioUrl = URL.createObjectURL(audioBlob);

        subtitle.audioStatus = "loaded";
        subtitle.audioUrl = audioUrl;

        // 计算音频时长并计算播放速率
        const tempAudio = new Audio(audioUrl);
        tempAudio.onloadedmetadata = () => {
          subtitle.audioDuration = tempAudio.duration;
          const subtitleDuration = Math.max(
            0.01,
            subtitle.endTime - subtitle.startTime
          );
          if (subtitle.audioDuration && subtitle.audioDuration > 0) {
            subtitle.playbackRate = subtitleDuration / subtitle.audioDuration;
          } else {
            subtitle.playbackRate = null;
          }
          updateSubtitleStatusUI(subtitle.id, "loaded");
          // 检查视频是否因等待此字幕而暂停
          if (pausedForSubtitleId === subtitle.id && video) {
            console.log(
              `缓存音频 ${subtitle.id} 加载完成，恢复视频播放并播放音频。`
            );
            video.play(); // 恢复视频播放
            playAudio(subtitle.audioUrl, subtitle.id, false); // 播放音频
            lastPlayedSubtitleId = subtitle.id; // 记录已播放
            pausedForSubtitleId = null; // 清除等待标记
          }
        };
        tempAudio.onerror = () => {
          subtitle.audioDuration = null;
          subtitle.playbackRate = null;
          updateSubtitleStatusUI(subtitle.id, "loaded");
        };
      } catch (e) {
        console.error(
          `Error decoding cached Base64 or creating Blob/URL for subtitle ${subtitle.id}:`,
          e
        );
        subtitle.audioStatus = "failed";
        updateSubtitleStatusUI(subtitle.id, "failed");
      }
    } else {
      // 未命中缓存，调用接口生成并保存到chrome.storage.local
      chrome.runtime.sendMessage(
        {
          action: "callGPTSoVITS",
          text: subtitle.text.trim(),
          language: "auto",
          noCache: isReload, // 添加 noCache 标志，其值等于 isReload 的当前状态
          ...(window.gptsoVitsParams || {}), // 添加已选择的语音参数
        },
        (response) => {
          if (chrome.runtime.lastError || (response && response.error)) {
            console.error(
              `Error loading audio for ${subtitle.id} (detected lastError or response.error):`,
              chrome.runtime.lastError || response.error
            );
            subtitle.audioStatus = "failed";
            updateSubtitleStatusUI(subtitle.id, "failed");
          } else if (
            response &&
            typeof response.audioBase64 === "string" &&
            response.audioBase64.length > 0
          ) {
            // 保存到chrome.storage.local
            const saveObj = {};
            saveObj[cacheKey] = response.audioBase64;
            chrome.storage.local.set(saveObj, () => {
              if (chrome.runtime.lastError) {
                console.warn(
                  `Failed to save audio to chrome.storage: ${cacheKey}`,
                  chrome.runtime.lastError.message
                );
              } else {
                console.log(`Audio saved to chrome.storage: ${cacheKey}`);
              }
            });
            // 正常流程
            try {
              const audioBuffer = base64ToArrayBuffer(response.audioBase64);
              const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
              const audioUrl = URL.createObjectURL(audioBlob);

              subtitle.audioStatus = "loaded";
              subtitle.audioUrl = audioUrl;

              // 计算音频时长并计算播放速率
              const tempAudio = new Audio(audioUrl);
              tempAudio.onloadedmetadata = () => {
                subtitle.audioDuration = tempAudio.duration;
                const subtitleDuration = Math.max(
                  0.01,
                  subtitle.endTime - subtitle.startTime
                );
                if (subtitle.audioDuration && subtitle.audioDuration > 0) {
                  subtitle.playbackRate =
                    subtitleDuration / subtitle.audioDuration;
                } else {
                  subtitle.playbackRate = null;
                }
                updateSubtitleStatusUI(subtitle.id, "loaded");
                // 检查是否需要恢复播放
                if (pausedForSubtitleId === subtitle.id && video) {
                  console.log(`API音频 ${subtitle.id} 加载完成，恢复播放。`);
                  video.play();
                  playAudio(subtitle.audioUrl, subtitle.id, false); // 播放音频
                  lastPlayedSubtitleId = subtitle.id;
                  pausedForSubtitleId = null;
                }
              };
              tempAudio.onerror = () => {
                subtitle.audioDuration = null;
                subtitle.playbackRate = null;
                updateSubtitleStatusUI(subtitle.id, "loaded");
              };
            } catch (e) {
              console.error(
                `Error decoding Base64 or creating Blob/URL for subtitle ${subtitle.id}:`,
                e
              );
              subtitle.audioStatus = "failed";
              updateSubtitleStatusUI(subtitle.id, "failed");
              reject(e);
            }
          } else {
            console.error(
              `Marking as failed due to invalid response (not error or valid Base64 string) for ${subtitle.id}. Full response logged above.`
            );
            subtitle.audioStatus = "failed";
            updateSubtitleStatusUI(subtitle.id, "failed");
            reject(new Error("Invalid response from audio generation service"));
          }
        }

      );
    }
  });
}
// 更新字幕列表中的状态显示
function updateSubtitleStatusUI(subtitleId, status) {
  if (!shadowRoot) return;
  const statusEl = shadowRoot.querySelector(
    `.audio-status[data-id="${subtitleId}"]`
  );
  if (statusEl) {
    updateSubtitleStatusElement(statusEl, status, subtitleId);
  }
}

// 更新单个状态元素的内部 HTML
function updateSubtitleStatusElement(element, status, subtitleId) {
  element.innerHTML = ""; // 清空现有内容
  switch (status) {
    case "loading":
      element.textContent = "加载中...";
      break;
    case "loaded":
      const button = document.createElement("button");
      button.className = "play-single-audio";
      button.dataset.id = subtitleId;
      button.textContent = "▶️"; // 播放图标
      button.title = "播放此句"; // 添加提示
      element.appendChild(button);

      // 显示播放速率
      const subtitle = subtitles.find((sub) => sub.id === subtitleId); // 需要在这里查找 subtitle
      if (
        subtitle &&
        subtitle.playbackRate &&
        typeof subtitle.playbackRate === "number"
      ) {
        const rateSpan = document.createElement("span");
        rateSpan.textContent = ` ${subtitle.playbackRate.toFixed(2)}x`; // 保留两位小数
        rateSpan.title = `建议播放速率: ${subtitle.playbackRate.toFixed(2)}`;
        rateSpan.style.fontSize = "0.8em";
        rateSpan.style.marginLeft = "4px"; // 与按钮保持一点距离
        element.appendChild(rateSpan);
      }
      break;
    case "failed":
      element.textContent = "加载失败";
      break;
    case "unloaded":
    default:
      element.textContent = "未加载";
      break;
  }
}

// 检查是否满足播放条件（当前及后5个字幕音频加载完成）

// 播放音频
function playAudio(audioUrl, subtitleId, isSinglePlay) {
  // 如果已静音，则不播放音频
  if (isMuted) {
    // 仍然高亮字幕，但不出声
    highlightCurrentSubtitle(subtitleId);
    // 如果有其他音频正在播放（理论上不应该，因为静音了），也停止它
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    // 模拟音频播放结束的逻辑，以便字幕可以继续（如果需要）
    // 或者根据具体需求调整这里的行为
    // 例如，如果静音时也希望视频按字幕节奏播放，可能需要其他机制
    // 此处简单返回，不创建 Audio 对象
    // 可以在 onended 逻辑中处理下一个字幕的播放（如果适用）
    // 为了简单起见，我们假设静音时，字幕高亮后就结束了“播放”
    // 如果有复杂的连续播放逻辑，这里需要更细致的处理
    // 触发一个模拟的 onended 事件，或者直接调用处理 onended 的函数
    // 确保在静音状态下，字幕的视觉同步（高亮）仍然发生
    // 并且，如果应用依赖 onended 来推进，需要模拟这个过程
    // 这里我们先简单处理，只高亮，不实际播放
    // 如果有视频同步，视频速率调整等逻辑，也需要考虑是否在静音时执行
    const subtitle = subtitles.find((sub) => sub.id === subtitleId);
    if (subtitle && video) {
        let targetRate = 1.0;
        if (subtitle.playbackRate && typeof subtitle.playbackRate === 'number' && subtitle.playbackRate > 0) {
            targetRate = subtitle.playbackRate;
        }
        video.playbackRate = Number(targetRate.toFixed(2));
        if (!isLearn) {
            // 非学习模式下，如果视频暂停了，则播放视频
            if (video.paused) video.play().catch(e => console.error("Error playing video in muted mode:", e));
        } else {
            // 学习模式下，音频（静音）“播放”后，视频应该继续播放
            video.play().catch(e => console.error("Error playing video in muted learn mode:", e));
        }
    }

    // 模拟音频结束后的行为，以便字幕流程可以继续
    // 这部分逻辑可能需要根据实际的 onended 处理来调整
    setTimeout(() => {
        highlightCurrentSubtitle(null); // 清除高亮
        if (video) video.playbackRate = 1.0; // 重置速率
        if (isSinglePlay && video) {
            video.pause();
        }
        // 如果有连续播放逻辑，这里可能需要触发下一条字幕的处理
        // 例如，手动调用 video 的 timeupdate 事件处理函数，或者其他机制
    }, 1000); // 假设一个短暂的“播放”时间

    return; 
  }

  // --- 防止重复播放 ---
  if (currentAudio && currentAudio.src === audioUrl) {
    // console.log(`Audio ${subtitleId} is already playing or requested.`);
    return;
  }
  // 如果有其他音频正在播放，先停止
  stopCurrentAudio();
  // --- 结束防止重复播放 ---

  highlightCurrentSubtitle(subtitleId); // 音频即将播放时高亮

  // 检查 URL 是否有效
  if (!audioUrl || typeof audioUrl !== "string") {
    console.error(`Invalid audio URL for subtitle ${subtitleId}:`, audioUrl);
    const sub = subtitles.find((s) => s.id === subtitleId);
    if (sub) {
      sub.audioStatus = "failed"; // 标记失败
      updateSubtitleStatusUI(subtitleId, "failed");
    }
    highlightCurrentSubtitle(null); // 清除高亮
    return;
  }

  // --- 应用播放速率 ---
  const subtitle = subtitles.find((sub) => sub.id === subtitleId);
  let targetRate = 1.0;
  // 中文注释：如果字幕有 playbackRate 字段，则将其应用到视频元素
  if (
    video &&
    subtitle &&
    typeof subtitle.playbackRate === "number" &&
    !isNaN(subtitle.playbackRate)
  ) {
    video.playbackRate = subtitle.playbackRate;
    targetRate = subtitle.playbackRate;
  }
  if (
    video &&
    subtitle &&
    subtitle.playbackRate &&
    typeof subtitle.playbackRate === "number" &&
    subtitle.playbackRate > 0
  ) {
    targetRate = subtitle.playbackRate;
  }
  if (video) {
    // console.log(`Setting video playback rate to: ${targetRate.toFixed(2)} for subtitle ${subtitleId}`);
    // 设置视频播放速率，保留两位小数
    video.playbackRate = Number(targetRate.toFixed(2));
  }
  // --- 结束应用播放速率 ---

  currentAudio = new Audio(audioUrl);
  currentAudio.dataset.subtitleId = subtitleId; // 标记音频对应的字幕ID
  currentAudio.muted = isMuted; // 根据静音状态设置音频的muted属性

  // 确保音频实际开始播放时再次同步视频速率
  currentAudio.onplay = () => {
    const subtitle = subtitles.find((sub) => sub.id === subtitleId);

    if (!isLearn) {
      let targetRate = 1.0;
      if (
        video &&
        subtitle &&
        subtitle.playbackRate &&
        typeof subtitle.playbackRate === "number" &&
        subtitle.playbackRate > 0
      ) {
        targetRate = subtitle.playbackRate;
      }
      if (video) {
        // 设置视频播放速率，保留两位小数
        video.playbackRate = Number(targetRate.toFixed(2));
      }
    } else {
      if (video) video.pause();
    }
  };

  currentAudio.play().catch((e) => {
    console.error(`Error playing audio for ${subtitleId}:`, e);
    highlightCurrentSubtitle(null); // 播放失败清除高亮
    if (video) video.playbackRate = 1.0; // 播放失败重置速率
    currentAudio = null; // 清除引用
  });

  // 音频实际开始播放时（可选，用于更精确的高亮）
  // currentAudio.onplaying = () => {
  //   highlightCurrentSubtitle(subtitleId);
  // };

  currentAudio.onended = () => {
    // console.log(`Audio ended for ${subtitleId}`);
    if (currentAudio && currentAudio.dataset.subtitleId === subtitleId) {
      currentAudio = null; // 清除引用
    }
    highlightCurrentSubtitle(null); // 音频结束时清除高亮
    if (video) video.playbackRate = 1.0; // 音频结束时重置速率

    if (isSinglePlay && video) {
      // console.log(`Single audio ended, pausing video.`);
      video.pause(); // 单句播放结束时暂停视频
    }
    // 对于连续播放，不需要在这里处理，timeupdate 会找到下一个
    if (isLearn && video) {
      video.play(); // 语言学习模式下，音频结束后继续播放视频
    }
  };

  currentAudio.onerror = (e) => {
    console.error(`Error during audio playback for ${subtitleId}:`, e);
    if (currentAudio && currentAudio.dataset.subtitleId === subtitleId) {
      currentAudio = null; // 清除引用
    }
    highlightCurrentSubtitle(null); // 播放出错时清除高亮
    if (video) video.playbackRate = 1.0; // 播放出错时重置速率
  };
}

// 停止当前播放的音频
function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null; // 移除事件监听器
    currentAudio.onerror = null; // 移除错误监听器
    // currentAudio.src = ""; // 避免潜在的内存问题，但可能导致无法立即重播，暂时注释
    currentAudio = null;
    highlightCurrentSubtitle(null); // 停止音频时清除高亮
    if (video) video.playbackRate = 1.0; // 停止音频时重置视频速率
    // console.log("Stopped current audio and reset video rate."); // 调试日志
  }
}

// 高亮当前字幕行
function highlightCurrentSubtitle(subtitleId) {
  if (!shadowRoot) return;
  const subtitleListEl = shadowRoot.getElementById("subtitle-list");
  if (!subtitleListEl) return;

  // 移除旧的高亮
  const highlighted = subtitleListEl.querySelector(".subtitle-item.highlight");
  if (highlighted) {
    highlighted.classList.remove("highlight");
  }

  // 添加新的高亮
  if (subtitleId) {
    const currentItem = subtitleListEl.querySelector(
      `.subtitle-item[data-id="${subtitleId}"]`
    );
    if (currentItem) {
      currentItem.classList.add("highlight");
      // 滚动到视图（可选）
      // currentItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

// (adjustPlaybackRate 函数可以移除或保留，当前未被调用)

// --- 辅助函数 ---

// 将 Base64 字符串解码为 ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// Function to position the popup relative to the floating button
function positionPopupRelativeToFloatingButton() {
  if (!floatingControlBtn || !popupDiv) {
    return;
  }

  const floatingBtnRect = floatingControlBtn.getBoundingClientRect();
  const popupWidth = 400; // As defined in popupDiv style
  const popupHeight = 500; // As defined in popupDiv style
  const generalOffset = 10; // Space from floating button or screen edges

  let finalTop = floatingBtnRect.bottom - popupHeight; // Align bottom of popup with bottom of floating button
  let finalLeft;

  // Attempt 1: Position to the right of the floating button
  let preferredLeft = floatingBtnRect.right + generalOffset;
  if (
    preferredLeft >= 0 &&
    preferredLeft + popupWidth <= window.innerWidth &&
    finalTop >= 0 &&
    finalTop + popupHeight <= window.innerHeight
  ) {
    finalLeft = preferredLeft;
  } else {
    // Attempt 2: Position to the left of the floating button
    let alternativeLeft = floatingBtnRect.left - popupWidth - generalOffset;
    if (
      alternativeLeft >= 0 &&
      alternativeLeft + popupWidth <= window.innerWidth &&
      finalTop >= 0 &&
      finalTop + popupHeight <= window.innerHeight
    ) {
      finalLeft = alternativeLeft;
    } else {
      // Fallback: General clamping to keep popup on screen, starting with preferred right
      finalLeft = floatingBtnRect.right + generalOffset; // Default to right
      // Clamp finalLeft
      if (finalLeft + popupWidth > window.innerWidth - generalOffset) {
        finalLeft = window.innerWidth - popupWidth - generalOffset;
      }
      if (finalLeft < generalOffset) {
        finalLeft = generalOffset;
      }

      // Recalculate finalTop for this general fallback, as it might have been pushed too high/low
      // by the button's position if the button is near top/bottom edge.
      // Let's try to keep it vertically centered with the button if possible, or clamp.
      finalTop =
        floatingBtnRect.top + floatingBtnRect.height / 2 - popupHeight / 2;

      // Clamp finalTop
      if (finalTop + popupHeight > window.innerHeight - generalOffset) {
        finalTop = window.innerHeight - popupHeight - generalOffset;
      }
      if (finalTop < generalOffset) {
        finalTop = generalOffset;
      }
    }
  }

  popupDiv.style.left = `${finalLeft}px`;
  popupDiv.style.top = `${finalTop}px`;
  popupDiv.style.right = "auto";
  popupDiv.style.bottom = "auto";
}

// 设置浮动按钮的默认位置（视频左上角）
function setDefaultFloatingButtonPosition(floatingBtn) {
  // 使用现有的视频查找逻辑
  const currentVideo = video || findVideoElement();
  
  if (currentVideo) {
    try {
      const videoRect = currentVideo.getBoundingClientRect();
      // 获取视频元素相对于视口的位置
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
      
      // 计算视频左上角的绝对位置（考虑滚动）
      const videoLeft = videoRect.left + scrollLeft + 10; // 向右偏移10px
      const videoTop = videoRect.top + scrollTop + 10;   // 向下偏移10px
      
      // 设置浮动按钮位置
      floatingBtn.style.left = `${videoLeft}px`;
      floatingBtn.style.top = `${videoTop}px`;
      floatingBtn.style.right = "auto";
      floatingBtn.style.bottom = "auto";
      
      console.log(`Floating button positioned at video top-left: left=${videoLeft}px, top=${videoTop}px`);
      console.log(`Video rect:`, videoRect);
    } catch (error) {
      console.warn("Error positioning floating button relative to video:", error);
      // 如果出错，回退到右下角位置
      setFallbackPosition(floatingBtn);
    }
  } else {
    console.log("Video element not found, using fallback position");
    setFallbackPosition(floatingBtn);
  }
}

// 回退位置设置（右下角）
function setFallbackPosition(floatingBtn) {
  floatingBtn.style.right = "20px";
  floatingBtn.style.bottom = "20px";
  floatingBtn.style.left = "auto";
  floatingBtn.style.top = "auto";
  console.log("Fallback position set: right=20px, bottom=20px");
}

// 创建一个可移动的悬浮按钮控制所有UI元素
function createFloatingButton() {
  console.log("Creating floating button...");
  const localFloatingBtn = document.createElement("div"); // Use local var first
  localFloatingBtn.id = "floating-control-btn";
  localFloatingBtn.textContent = "🎭";
  console.log("Floating button element created:", localFloatingBtn);

  // 默认样式
  const defaultStyle = {
    position: "fixed",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    backgroundColor: "#fff",
    border: "2px solid #ccc",
    boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
    cursor: "move",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "20px",
    zIndex: "10000",
    userSelect: "none",
  };

  // 应用默认样式
  Object.assign(localFloatingBtn.style, defaultStyle);
  console.log("Default styles applied to floating button");

  // 立即设置一个默认位置，避免异步问题
  setDefaultFloatingButtonPosition(localFloatingBtn);

  // 从 storage 加载保存的位置
  chrome.storage.local.get(["floatingBtnPos"], (result) => {
    console.log("Storage callback executed, saved position:", result.floatingBtnPos);
    if (
      result.floatingBtnPos &&
      result.floatingBtnPos.left !== undefined &&
      result.floatingBtnPos.top !== undefined
    ) {
      localFloatingBtn.style.left = `${result.floatingBtnPos.left}px`;
      localFloatingBtn.style.top = `${result.floatingBtnPos.top}px`;
      localFloatingBtn.style.right = "auto"; // 清除默认的 right 和 bottom
      localFloatingBtn.style.bottom = "auto";
      console.log(`Position updated from storage: left=${result.floatingBtnPos.left}px, top=${result.floatingBtnPos.top}px`);
    } else {
      // 如果没有保存的位置，使用默认视频左上角位置
      setDefaultFloatingButtonPosition(localFloatingBtn);
    }
    // Position popup once floating button's position is set
    positionPopupRelativeToFloatingButton();
  });

  // 添加拖动功能
  let isDraggingBtn = false; // Renamed to avoid conflict with popup drag
  let startXBtn, startYBtn; // Renamed

  localFloatingBtn.addEventListener("mousedown", (e) => {
    isDraggingBtn = true;
    startXBtn = e.clientX - localFloatingBtn.offsetLeft;
    startYBtn = e.clientY - localFloatingBtn.offsetTop;
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDraggingBtn) return;

    let newLeft = e.clientX - startXBtn;
    let newTop = e.clientY - startYBtn;

    // 边界检查
    newLeft = Math.max(0, Math.min(window.innerWidth - 40, newLeft));
    newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));

    localFloatingBtn.style.left = newLeft + "px";
    localFloatingBtn.style.top = newTop + "px";
    localFloatingBtn.style.right = "auto";
    localFloatingBtn.style.bottom = "auto";
    // Re-position popup as floating button moves
    positionPopupRelativeToFloatingButton();
  });

  document.addEventListener("mouseup", () => {
    if (isDraggingBtn) {
      isDraggingBtn = false;
      // 保存当前位置到 storage
      const currentPos = {
        left: localFloatingBtn.offsetLeft,
        top: localFloatingBtn.offsetTop,
      };
      chrome.storage.local.set({ floatingBtnPos: currentPos }, () => {
        console.log("Floating button position saved:", currentPos);
      });
      // Final position update for popup
      positionPopupRelativeToFloatingButton();
    }
  });

  // 点击切换UI元素显示/隐藏
  let uiVisible = false; // Renamed to avoid conflict
  localFloatingBtn.addEventListener("click", (e) => {
    // Check if the click was part of a drag
    // A simple way: if mouseup just happened for this button, it was a drag.
    // However, click fires after mouseup. A more robust way is to check mouse movement.
    // For simplicity, we assume if isDraggingBtn is false, it's a click.
    if (!isDraggingBtn) {
      e.stopPropagation();
      uiVisible = !uiVisible;
      localFloatingBtn.style.backgroundColor = uiVisible ? "#e6f3ff" : "#fff";
      localFloatingBtn.style.borderColor = uiVisible ? "#1a73e8" : "#ccc";

      if (popupDiv) {
        popupDiv.style.display = uiVisible ? "block" : "none";
        if (uiVisible) {
          positionPopupRelativeToFloatingButton(); // Position when shown
        }
      }
      // 只切换 popupDiv 的显示，不隐藏字幕栏
    }
  });

  document.body.appendChild(localFloatingBtn);
  console.log("Floating button appended to body. Button style:", localFloatingBtn.style.cssText);
  
  // 添加可见性验证
  setTimeout(() => {
    const rect = localFloatingBtn.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0;
    console.log("Floating button visibility check:");
    console.log("  - Bounding rect:", rect);
    console.log("  - Is visible:", isVisible);
    console.log("  - Display style:", window.getComputedStyle(localFloatingBtn).display);
    console.log("  - Visibility style:", window.getComputedStyle(localFloatingBtn).visibility);
    console.log("  - Z-index:", window.getComputedStyle(localFloatingBtn).zIndex);
    
    if (!isVisible) {
      console.error("⚠️ 浮动按钮不可见！");
      // 尝试强制设置样式
      localFloatingBtn.style.display = "flex";
      localFloatingBtn.style.visibility = "visible";
      localFloatingBtn.style.opacity = "1";
      console.log("Applied force visible styles");
    } else {
      console.log("✅ 浮动按钮可见");
    }
  }, 100);
  
  return localFloatingBtn; // Return the created button
}
