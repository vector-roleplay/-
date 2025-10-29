// 快速响应部队 - 事件处理核心
// 由Cline移植并重构

import { getContext, extension_settings } from '/scripts/extensions.js';
import { saveChatConditional, reloadCurrentChat } from '/script.js';
import { checkAndFixWithAPI } from './api.js';

const extensionName = 'quick-response-force';

/**
 * 在收到新消息时触发的事件处理程序。
 * @param {object} data - 事件数据（可选）。
 */
export async function onMessageReceived(data) {
    const context = getContext();

    // 忽略非AI生成或正在等待用户输入的情况
    if ((data && data.source) || context.isWaitingForUserInput) {
        return;
    }

    const settings = extension_settings[extensionName];
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        return;
    }

    const latestMessage = chat[chat.length - 1];

    // 只处理AI的消息
    if (latestMessage.is_user) {
        return;
    }

    // 检查优化功能是否启用
    if (!settings.enabled || !settings.optimizationEnabled || !settings.apiUrl) {
        return;
    }

    // 确保是AI对用户的直接回复，以避免处理系统消息或连续的AI消息
    if (chat.length < 2 || !chat[chat.length - 2].is_user) {
        console.log(`[${extensionName}] 检测到消息并非AI对用户的直接回复，已跳过优化。`);
        return;
    }

    // 获取上下文消息
    const contextMessagesCount = settings.contextMessages || 2;
    const startIndex = Math.max(0, chat.length - 1 - contextMessagesCount);
    const contextMessages = chat.slice(startIndex, chat.length - 1);

    // 调用核心优化API
    const result = await checkAndFixWithAPI(latestMessage, contextMessages);

    if (result && result.optimizedContent && result.optimizedContent !== latestMessage.mes) {
        console.log(`[${extensionName}] 内容已优化，正在更新消息...`);
        latestMessage.mes = result.optimizedContent;
        await saveChatConditional(); // 保存聊天记录

        // 如果设置为“刷新”模式，则刷新聊天界面
        if (settings.optimizationMode === 'refresh') {
            await reloadCurrentChat();
        }
    }
}

/**
 * 在聊天内容改变时触发的事件处理程序。
 * 目前在仅优化模式下不需要复杂逻辑，保留为空或用于未来扩展。
 */
export function onChatChanged() {
    // 逻辑可以留空，因为我们移除了与“待处理总结”相关的逻辑
    // console.log(`[${extensionName}] 聊天已变更。`);
}
