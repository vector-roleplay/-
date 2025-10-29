// 快速响应部队 - 世界书处理模块
// 由Cline移植并重构，核心功能来自Amily2号插件

import { safeCharLorebooks, safeLorebookEntries } from './tavernhelper-compatibility.js';

/**
 * 提取并合并当前角色所有关联世界书的内容，并根据新的、支持递归的筛选逻辑进行处理。
 * 
 * @param {object} context - SillyTavern的上下文对象.
 * @param {object} apiSettings - 插件的API设置.
 * @returns {Promise<string>} - 返回一个包含所有最终触发的世界书条目内容的字符串。
 */
export async function getCombinedWorldbookContent(context, apiSettings) {
    // [架构重构 & 功能更新] 始终使用传入的、已经合并好的apiSettings作为唯一数据源，不再从UI面板读取。
    // 这确保了无论UI是否打开，核心逻辑都使用一致且正确的设置。

    if (!apiSettings.worldbookEnabled) {
        return '';
    }

    if (!context) {
        console.warn('[剧情优化大师] Context 未提供，无法获取世界书内容。');
        return '';
    }

    try {
        let bookNames = [];
        
        if (apiSettings.worldbookSource === 'manual') {
            bookNames = apiSettings.selectedWorldbooks || [];
            if (bookNames.length === 0) return '';
        } else {
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            if (bookNames.length === 0) return '';
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await safeLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        if (allEntries.length === 0) return '';

        // [功能更新] 应用反向选择逻辑：过滤掉那些在disabledWorldbookEntries中被记录的条目。
        const disabledEntriesMap = apiSettings.disabledWorldbookEntries || {};
        const userEnabledEntries = allEntries.filter(entry => {
            // 首先，条目本身必须在SillyTavern中是启用的
            if (!entry.enabled) return false;
            
            // 其次，它不能出现在我们的禁用列表中
            const isDisabled = disabledEntriesMap[entry.bookName]?.includes(entry.uid);
            return !isDisabled;
        });

        if (userEnabledEntries.length === 0) return '';
        
        const chatHistory = context.chat.map(message => message.mes).join('\n').toLowerCase();
        const getEntryKeywords = (entry) => [...new Set([...(entry.key || []), ...(entry.keys || [])])].map(k => k.toLowerCase());

        const blueLightEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
        let pendingGreenLights = userEnabledEntries.filter(entry => entry.type !== 'constant');
        
        const triggeredEntries = new Set([...blueLightEntries]);

        while (true) {
            let hasChangedInThisPass = false;
            
            const recursionSourceContent = Array.from(triggeredEntries)
                .filter(e => !e.prevent_recursion)
                .map(e => e.content)
                .join('\n')
                .toLowerCase();
            const fullSearchText = `${chatHistory}\n${recursionSourceContent}`;

            const nextPendingGreenLights = [];
            
            for (const entry of pendingGreenLights) {
                const keywords = getEntryKeywords(entry);
                let isTriggered = keywords.length > 0 && keywords.some(keyword => 
                    entry.exclude_recursion ? chatHistory.includes(keyword) : fullSearchText.includes(keyword)
                );

                if (isTriggered) {
                    triggeredEntries.add(entry);
                    hasChangedInThisPass = true;
                } else {
                    nextPendingGreenLights.push(entry);
                }
            }
            
            if (!hasChangedInThisPass) break;
            
            pendingGreenLights = nextPendingGreenLights;
        }

        const finalContent = Array.from(triggeredEntries).map(entry => entry.content).filter(Boolean);
        if (finalContent.length === 0) return '';

        const combinedContent = finalContent.join('\n\n---\n\n');
        
        const limit = apiSettings.worldbookCharLimit || 60000;
        if (combinedContent.length > limit) {
            console.log(`[剧情优化大师] 世界书内容 (${combinedContent.length} chars) 超出限制 (${limit} chars)，将被截断。`);
            return combinedContent.substring(0, limit);
        }

        return combinedContent;

    } catch (error) {
        console.error(`[剧情优化大师] 处理世界书逻辑时出错:`, error);
        return '';
    }
}
