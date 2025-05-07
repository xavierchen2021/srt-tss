// 处理popup界面交互
document.addEventListener("DOMContentLoaded", () => {
  const selectFileBtn = document.getElementById("select-file");
  // 已移除播放按钮相关代码
  const closeBtn = document.getElementById("close-btn");
  const currentSubtitleEl = document.getElementById("current-subtitle");
  const subtitleListEl = document.getElementById("subtitle-list");

  // let isPlaying = false; // 已移除播放按钮相关代码
  let subtitles = [];

  // 清空缓存按钮事件
  const clearCacheBtn = document.getElementById("clear-cache");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", () => {
      // 获取当前活动标签页
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        // 发送清空缓存请求到 background
        chrome.runtime.sendMessage({
          action: "clearCache",
          tabId: tabs[0]?.id,
        });
      });
    });
  }

  // 选择字幕文件
  selectFileBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "selectFile" }, (response) => {
      if (response.error) {
        console.error("Error selecting file:", response.error);
        return;
      }

      // 解析字幕文件
      subtitles = parseSubtitleFile(response.content);
      renderSubtitleList();

      // 发送字幕数据到content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: "updateSubtitles",
          subtitles: subtitles,
        });
      });
    });
  });

  // 已移除播放/暂停控制相关代码

  // 关闭按钮
  closeBtn.addEventListener("click", () => {
    window.close();
  });

  // 解析字幕文件
  function parseSubtitleFile(content) {
    // 简单解析SRT格式
    const lines = content.split("\n");
    const result = [];
    let currentSub = null;

    lines.forEach((line) => {
      line = line.trim();
      if (!line) return;

      if (line.match(/^\d+$/)) {
        // 字幕序号
        if (currentSub) result.push(currentSub);
        currentSub = { id: line };
      } else if (
        line.match(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/)
      ) {
        // 时间轴
        const [start, end] = line.split(" --> ");
        currentSub.startTime = parseTime(start);
        currentSub.endTime = parseTime(end);
      } else if (currentSub) {
        // 字幕文本
        currentSub.text = (currentSub.text || "") + line + "\n";
      }
    });

    if (currentSub) result.push(currentSub);
    return result;
  }

  // 解析时间格式
  function parseTime(timeStr) {
    const [hms, ms] = timeStr.split(",");
    const [h, m, s] = hms.split(":");
    return (
      parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000
    );
  }

  // 渲染字幕列表
  function renderSubtitleList() {
    subtitleListEl.innerHTML = "";

    // 动态插入列表头部，包含收缩按钮和清空缓存按钮
    const headerDiv = document.createElement("div");
    headerDiv.className = "list-header";
    headerDiv.style.display = "flex";
    headerDiv.style.justifyContent = "space-between";
    headerDiv.style.alignItems = "center";
    headerDiv.style.marginBottom = "6px";

    // 收缩按钮
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "toggle-list-btn";
    toggleBtn.textContent = "⬇️";
    toggleBtn.style.marginRight = "8px";
    toggleBtn.style.fontSize = "1.1em";

    // 清空缓存按钮
    const clearBtn = document.createElement("button");
    clearBtn.id = "clear-cache";
    clearBtn.textContent = "清空缓存";
    clearBtn.style.backgroundColor = "#ffdddd";
    clearBtn.style.border = "1px solid #ff5555";
    clearBtn.style.color = "#a00";
    clearBtn.style.fontWeight = "bold";
    clearBtn.style.marginLeft = "8px";

    // 按钮加入头部
    headerDiv.appendChild(toggleBtn);
    headerDiv.appendChild(clearBtn);
    subtitleListEl.appendChild(headerDiv);

    // 绑定收缩事件
    toggleBtn.addEventListener("click", () => {
      subtitleListEl.classList.toggle("collapsed");
      toggleBtn.textContent = subtitleListEl.classList.contains("collapsed")
        ? "⬆️"
        : "⬇️";
    });

    // 绑定清空缓存事件
    clearBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.runtime.sendMessage({
          action: "clearCache",
          tabId: tabs[0]?.id,
        });
      });
    });

    // 渲染字幕项
    subtitles.forEach((sub) => {
      const item = document.createElement("div");
      item.className = "subtitle-item";
      item.innerHTML = `
        <div class="subtitle-text">${sub.text.trim()}</div>
        <div class="audio-status" data-id="${sub.id}">未加载</div>
      `;
      subtitleListEl.appendChild(item);
    });
  }

  // 监听来自content script的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateCurrentSubtitle") {
      currentSubtitleEl.textContent = request.text || "当前无字幕";
    }
  });
});
