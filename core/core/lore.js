// 快速响应部队 - 世界书处理模块
// 由Cline移植并重构，核心功能来自Amily2号插件

/**
 * 提取并合并当前角色所有关联世界书的内容，并根据新的、支持递归的筛选逻辑进行处理。
 * 
 * @param {object} context - SillyTavern的上下文对象.
 * @param {object} apiSettings - 插件的API设置.
 * @returns {Promise<string>} - 返回一个包含所有最终触发的世界书条目内容的字符串。
 */
export async function getCombinedWorldbookContent(context, apiSettings) {
    // [核心修复] 运行时直接从UI读取所有世界书相关设置，确保数据源绝对一致。
    const panel = $('#qrf_settings_panel');
    let liveSettings = {};

    if (panel.length > 0) {
        liveSettings.worldbookEnabled = panel.find('#qrf_worldbook_enabled').is(':checked');
        liveSettings.worldbookSource = panel.find('input[name="qrf_worldbook_source"]:checked').val() || 'character';
        liveSettings.selectedWorldbooks = panel.find('#qrf_selected_worldbooks').val() || [];
        liveSettings.worldbookCharLimit = parseInt(panel.find('#qrf_worldbook_char_limit').val(), 10) || 60000;

        // 实时构建启用的条目列表，这部分逻辑模仿自 bindings.js 中的 saveEnabledEntries
        let enabledEntries = {};
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').each(function() {
            if ($(this).is(':checked')) {
                const bookName = $(this).data('book');
                const uid = parseInt($(this).data('uid'));
                if (!enabledEntries[bookName]) {
                    enabledEntries[bookName] = [];
                }
                enabledEntries[bookName].push(uid);
            }
        });
        liveSettings.enabledWorldbookEntries = enabledEntries;
    } else {
        // 如果UI面板不存在，则回退到传入的设置，以保证在无UI环境下的兼容性
        console.warn('[剧情优化大师] 未找到设置面板，世界书功能将回退到使用已保存的设置。');
        liveSettings = {
            worldbookEnabled: apiSettings.worldbookEnabled,
            worldbookSource: apiSettings.worldbookSource,
            selectedWorldbooks: apiSettings.selectedWorldbooks,
            worldbookCharLimit: apiSettings.worldbookCharLimit,
            enabledWorldbookEntries: apiSettings.enabledWorldbookEntries,
        };
    }

    if (!liveSettings.worldbookEnabled) {
        return '';
    }

    if (!window.TavernHelper?.getLorebookEntries || !context) {
        console.warn('[剧情优化大师] TavernHelper API 或 context 未提供，无法获取世界书内容。');
        return '';
    }

    try {
        let bookNames = [];
        
        if (liveSettings.worldbookSource === 'manual') {
            bookNames = liveSettings.selectedWorldbooks;
            if (bookNames.length === 0) return '';
        } else {
            const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            if (bookNames.length === 0) return '';
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await window.TavernHelper.getLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        if (allEntries.length === 0) return '';
        
        const enabledEntriesMap = liveSettings.enabledWorldbookEntries || {};
        const userEnabledEntries = allEntries.filter(entry => {
            if (!entry.enabled) return false;
            const bookConfig = enabledEntriesMap[entry.bookName];
            return bookConfig ? bookConfig.includes(entry.uid) : false;
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
        
        const limit = liveSettings.worldbookCharLimit;
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
