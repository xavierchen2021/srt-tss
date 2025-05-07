// 后台脚本，处理文件选择和API调用
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed");
});

// 监听文件选择
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 获取wav文件列表
  if (request.action === "getWavFiles") {
    const fs = require("fs").promises;
    fs.readdir("/Users/apple/Downloads/bhys")
      .then(async (files) => {
        const wavFiles = files.filter((file) => file.endsWith(".wav"));
        const result = [];
        for (const file of wavFiles) {
          const parts = file.split("-");
          if (parts.length >= 2) {
            result.push({
              filename: file,
              voice: parts[1],
              text: parts.length > 2 ? parts[2].replace(".wav", "") : "",
            });
          }
        }
        sendResponse({ files: result });
      })
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // 保留其他消息处理逻辑

  // 处理清空缓存请求
  if (request.action === "clearCache") {
    // 通知 content.js 清空缓存并重新获取数据
    if (request.tabId) {
      chrome.tabs.sendMessage(request.tabId, { action: "clearCache" });
    }
    return;
  }

  if (request.action === "callGPTSoVITS") {
    // 构建API URL
    let apiUrl = "http://127.0.0.1:9880/tts"; // 更新 API endpoint

    // 准备请求体

    const requestBody = {
      text: request.text,
      text_lang: request.text_lang || "zh", // 从请求中获取或使用默认值
      ref_audio_path:
        request.ref_audio_path ||
        "/Users/apple/Downloads/bhys/我的确通晓各种观念，但亲身体验总归更有趣些。.wav", // 必选参数
      prompt_text:
        request.prompt_text || "我的确通晓各种观念，但亲身体验总归更有趣些。", // 可选参数
      prompt_lang: request.prompt_lang || "zh", // 从请求中获取或使用默认值
      top_k: request.top_k || 5,
      top_p: request.top_p || 1,
      temperature: request.temperature || 1,
      text_split_method: request.text_split_method || "cut0",
      batch_size: request.batch_size || 1,
      speed_factor: request.speed_factor || 1.0,
      streaming_mode: true, // 确保布尔值正确传递
      // 根据需要添加更多可选参数
    };

    // 移除请求体中的 undefined 或 null 值，以避免发送不必要的参数
    Object.keys(requestBody).forEach((key) => {
      if (requestBody[key] === undefined || requestBody[key] === null) {
        delete requestBody[key];
      }
    });

    fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Cache-Control 可以在需要时添加，当前 API 设计似乎不需要客户端控制缓存
      },
      body: JSON.stringify(requestBody),
    })
      .then(async (response) => {
        // 将回调设为 async 以便处理 JSON 错误
        if (!response.ok) {
          // 如果 API 返回非 2xx 状态码，尝试解析 JSON 错误信息
          const errorData = await response.json().catch(() => null); // 尝试解析错误JSON，失败则为null
          if (errorData && errorData.error) {
            throw new Error(
              `API Error: ${
                errorData.error.message || JSON.stringify(errorData.error)
              } (Status: ${response.status})`
            );
          }
          throw new Error(`API request failed with status ${response.status}`);
        }
        // API 成功时返回音频数据
        return response.blob(); // 获取响应体为 Blob
      })
      .then((audioBlob) => {
        // 将 Blob 转换为 ArrayBuffer
        return audioBlob.arrayBuffer();
      })
      .then((arrayBuffer) => {
        console.log(
          `Converting ArrayBuffer (size: ${arrayBuffer.byteLength}) to Base64.`
        );
        // 将 ArrayBuffer 转换为 Base64 字符串
        const base64String = arrayBufferToBase64(arrayBuffer);
        console.log(
          `Sending Base64 string (length: ${base64String.length}) back to content script.`
        );
        // 发送包含 Base64 字符串的 JSON 对象
        sendResponse({ audioBase64: base64String });
      })
      .catch((error) => {
        console.error("Error fetching audio or converting to Base64:", error); // 记录详细错误
        sendResponse({ error: error.message });
      });
    return true; // 保持异步响应
  }

  // 读取本地音频文件
  if (request.action === "readAudioFile") {
    const fs = require("fs").promises;
    fs.readFile(request.path)
      .then((data) => {
        const base64String = data.toString("base64");
        sendResponse({ audioBase64: base64String });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true;
  }

  // 保存音频文件到本地（通过 chrome.downloads API 触发下载）
  if (request.action === "saveAudioFile") {
    try {
      const url = "data:audio/wav;base64," + request.base64;
      chrome.downloads.download(
        {
          url: url,
          filename: request.path.replace(/^\/Users\/apple\/Downloads\//, ""), // 只保留 Downloads 下的相对路径
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, downloadId });
          }
        }
      );
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return true;
  }

  // --- 辅助函数 ---

  // 将 ArrayBuffer 转换为 Base64 字符串
  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener((tab) => {
  // 向当前活动标签页的内容脚本发送消息
  chrome.tabs.sendMessage(tab.id, { action: "togglePopup" });
});
