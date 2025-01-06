// AI 配置
const AI_CONFIG = {
  kimi: {
    url: 'https://kimi.moonshot.cn/',
    tabId: null
  },
  deepseek: {
    url: 'https://chat.deepseek.com/',
    tabId: null
  },
  tongyi: {
    url: 'https://tongyi.aliyun.com/',
    tabId: null
  }
};

let questionTabId = null;

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // 查找匹配的 AI
    Object.entries(AI_CONFIG).forEach(([aiType, config]) => {
      if (tab.url.includes(new URL(config.url).hostname)) {
        console.log(`找到 ${aiType} 标签页:`, tabId);
        config.tabId = tabId;
      }
    });

    // 检查是否是题目页面
    if (tab.url.includes('mooc1.chaoxing.com')) {
      console.log('找到题目标签页:', tabId);
      questionTabId = tabId;
    }
  }
});

// 监听标签页关闭
chrome.tabs.onRemoved.addListener((tabId) => {
  // 检查是否是 AI 标签页
  Object.entries(AI_CONFIG).forEach(([aiType, config]) => {
    if (config.tabId === tabId) {
      console.log(`${aiType} 标签页已关闭，重置 tabId`);
      config.tabId = null;
    }
  });

  // 检查是否是题目标签页
  if (tabId === questionTabId) {
    console.log('题目标签页已关闭，重置 questionTabId');
    questionTabId = null;
  }
});

// 处理消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('收到消息:', request.type);

  switch (request.type) {
    case 'GET_QUESTION':
      handleQuestion(request, sender.tab.id, sendResponse);
      return true;

    case 'ANSWER_READY':
      console.log('收到AI回答:', request.aiType, request.answer);
      handleAnswerReady(request);
      return true;

    case 'QUESTION_PAGE_READY':
      console.log('题目页面已就绪:', sender.tab.id);
      questionTabId = sender.tab.id;
      return true;
  }
});

// 处理AI回答准备就绪
async function handleAnswerReady(request) {
  console.log('当前题目页面 tabId:', questionTabId);

  // 如果没有 questionTabId，尝试查找题目页面
  if (!questionTabId) {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && tab.url.includes('mooc1.chaoxing.com')) {
          console.log('找到题目页面:', tab.id);
          questionTabId = tab.id;
          break;
        }
      }
    } catch (error) {
      console.error('查找题目页面失败:', error);
    }
  }

  // 如果仍然没有找到题目页面，尝试重试几次
  if (!questionTabId) {
    let retryCount = 0;
    const maxRetries = 3;
    const retryInterval = 1000; // 1秒

    const findQuestionTab = async () => {
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.url && tab.url.includes('mooc1.chaoxing.com')) {
            console.log('重试成功，找到题目页面:', tab.id);
            questionTabId = tab.id;
            // 发送答案
            chrome.tabs.sendMessage(questionTabId, {
              type: 'SHOW_ANSWER',
              answer: request.answer,
              aiType: request.aiType
            });
            return true;
          }
        }
        return false;
      } catch (error) {
        console.error('重试查找题目页面失败:', error);
        return false;
      }
    };

    const retry = async () => {
      if (retryCount >= maxRetries) {
        console.error('达到最大重试次数，未找到题目页面');
        return;
      }

      retryCount++;
      console.log(`第 ${retryCount} 次重试查找题目页面...`);

      if (!await findQuestionTab()) {
        setTimeout(retry, retryInterval);
      }
    };

    retry();
  } else {
    // 直接发送答案
    chrome.tabs.sendMessage(questionTabId, {
      type: 'SHOW_ANSWER',
      answer: request.answer,
      aiType: request.aiType
    });
  }
}

// 处理问题发送
async function handleQuestion(request, fromTabId, sendResponse) {
  console.log('正在处理问题...', request.aiType);
  const aiType = request.aiType;
  const config = AI_CONFIG[aiType];

  if (!config) {
    console.error('未知的 AI 类型:', aiType);
    return;
  }

  let targetTabId = config.tabId;

  // 检查现有标签页是否可用
  if (targetTabId) {
    try {
      // 尝试获取标签页信息
      const tab = await chrome.tabs.get(targetTabId);
      // 检查标签页是否已加载完成且URL正确
      if (!tab || !tab.url || !tab.url.includes(new URL(config.url).hostname)) {
        console.log(`${aiType} 标签页状态异常，需要重新创建`);
        targetTabId = null;
        config.tabId = null;
      }
    } catch (error) {
      // 如果获取标签页信息失败，说明标签页不存在
      console.log(`${aiType} 标签页不存在，需要重新创建`);
      targetTabId = null;
      config.tabId = null;
    }
  }

  // 如果目标AI标签页不存在或不可用，创建一个
  if (!targetTabId) {
    console.log(`正在打开 ${aiType} 页面...`);
    const tab = await chrome.tabs.create({
      url: config.url,
      active: false
    });
    targetTabId = tab.id;
    config.tabId = tab.id;

    // 等待页面加载完成
    await new Promise(resolve => {
      const listener = (tabId, changeInfo) => {
        if (tabId === targetTabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // 给页面一些额外时间初始化
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 发送问题到AI页面
  try {
    chrome.tabs.sendMessage(targetTabId, {
      type: 'ASK_QUESTION',
      question: request.question
    }, response => {
      console.log('AI页面响应:', response);
      if (response && response.success) {
        sendResponse({ success: true });
      } else {
        // 如果页面没有响应，可能需要重新加载
        console.log(`${aiType} 页面未响应，标记为需要重新创建`);
        config.tabId = null;
        sendResponse({ error: 'AI页面未响应' });
      }
    });
  } catch (error) {
    console.error(`发送消息到 ${aiType} 失败:`, error);
    config.tabId = null;
    sendResponse({ error: '发送消息失败' });
  }
} 