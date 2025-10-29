// 剧情规划大师 - 聊天优化插件
// 由Cline移植并重构，核心功能来自Amily2号插件

import { getContext, extension_settings } from '/scripts/extensions.js';
import { characters, this_chid } from '/script.js';
import { eventSource, event_types } from '/script.js';
import { createDrawer } from './ui/drawer.js';
import { callInterceptionApi } from './core/api.js';
import { getCombinedWorldbookContent } from './core/lore.js';
import { defaultSettings } from './utils/settings.js';

const extension_name = 'quick-response-force';
let isProcessing = false;
let tempPlotToSave = null; // [架构重构] 用于在生成和消息创建之间临时存储plot

/**
 * 将从 st-memory-enhancement 获取的原始表格JSON数据转换为更适合LLM读取的文本格式。
 * @param {object} jsonData - ext_exportAllTablesAsJson 返回的JSON对象。
 * @returns {string} - 格式化后的文本字符串。
 */
function formatTableDataForLLM(jsonData) {
    if (!jsonData || typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
        return '当前无任何可用的表格数据。';
    }

    let output = '以下是当前角色聊天记录中，由st-memory-enhancement插件保存的全部表格数据：\n';

    for (const sheetId in jsonData) {
        if (Object.prototype.hasOwnProperty.call(jsonData, sheetId)) {
            const sheet = jsonData[sheetId];
            // 确保表格有名称，且内容至少包含表头和一行数据
            if (sheet && sheet.name && sheet.content && sheet.content.length > 1) {
                output += `\n## 表格: ${sheet.name}\n`;
                const headers = sheet.content[0].slice(1); // 第一行是表头，第一个元素通常为空
                const rows = sheet.content.slice(1);

                rows.forEach((row, rowIndex) => {
                    const rowData = row.slice(1);
                    let rowOutput = '';
                    let hasContent = false;
                    headers.forEach((header, index) => {
                        const cellValue = rowData[index];
                        if (cellValue !== null && cellValue !== undefined && String(cellValue).trim() !== '') {
                            rowOutput += `  - ${header}: ${cellValue}\n`;
                            hasContent = true;
                        }
                    });

                    if (hasContent) {
                        output += `\n### ${sheet.name} - 第 ${rowIndex + 1} 条记录\n${rowOutput}`;
                    }
                });
            }
        }
    }
    output += '\n--- 表格数据结束 ---\n';
    return output;
}

/**
 * [新增] 转义正则表达式特殊字符。
 * @param {string} string - 需要转义的字符串.
 * @returns {string} - 转义后的字符串.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& 表示匹配到的整个字符串
}

/**
 * [架构重构] 从聊天记录中反向查找最新的plot。
 * @returns {string} - 返回找到的plot文本，否则返回空字符串。
 */
function getPlotFromHistory() {
    const context = getContext();
    if (!context || !context.chat || context.chat.length === 0) {
        return '';
    }

    // 从后往前遍历查找
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const message = context.chat[i];
        if (message.qrf_plot) {
            console.log(`[${extension_name}] Found plot in message ${i}`);
            return message.qrf_plot;
        }
    }
    return '';
}

/**
 * [架构重构] 将plot附加到最新的AI消息上。
 */
async function savePlotToLatestMessage() {
    if (tempPlotToSave) {
        const context = getContext();
        // 在SillyTavern的事件触发时，chat数组应该已经更新
        if (context.chat.length > 0) {
            const lastMessage = context.chat[context.chat.length - 1];
            // 确保是AI消息且没有被标记过，防止重复标记
            if (lastMessage && !lastMessage.is_user && !lastMessage.qrf_plot) {
                lastMessage.qrf_plot = tempPlotToSave;
                console.log(`[${extension_name}] Plot data attached to the latest AI message.`);
                // SillyTavern should handle saving automatically after generation ends.
            }
        }
        // 无论成功与否，都清空临时变量，避免污染下一次生成
        tempPlotToSave = null;
    }
}


/**
 * [重构] 核心优化逻辑，可被多处调用。
 * @param {string} userMessage - 需要被优化的用户输入文本。
 * @returns {Promise<string|null>} - 返回优化后的完整消息体，如果失败或跳过则返回null。
 */
async function runOptimizationLogic(userMessage) {
    let $toast = null;
    try {
        // 在每次执行前，都重新进行一次深度合并，以获取最新、最完整的设置状态
        const currentSettings = extension_settings[extension_name] || {};
        const settings = {
            ...defaultSettings,
            ...currentSettings,
            apiSettings: {
                ...defaultSettings.apiSettings,
                ...(currentSettings.apiSettings || {}),
            },
        };

        const panel = $('#qrf_settings_panel');
        if (panel.length > 0) {
            settings.apiSettings.apiMode = panel.find('input[name="qrf_api_mode"]:checked').val();
            settings.apiSettings.apiUrl = panel.find('#qrf_api_url').val();
            settings.apiSettings.apiKey = panel.find('#qrf_api_key').val();
            settings.apiSettings.model = panel.find('#qrf_model').val();
            settings.apiSettings.tavernProfile = panel.find('#qrf_tavern_api_profile_select').val();
            settings.minLength = parseInt(panel.find('#qrf_min_length').val(), 10) || 0;
            // [新增] 实时从UI读取上下文轮数，确保设置能立即生效
            settings.apiSettings.contextTurnCount = parseInt(panel.find('#qrf_context_turn_count').val(), 10) || 0;
            
            // [修复] 实时从UI读取提示词和速率设置，确保选择预设后立即生效
            settings.apiSettings.mainPrompt = panel.find('#qrf_main_prompt').val();
            settings.apiSettings.systemPrompt = panel.find('#qrf_system_prompt').val();
            settings.apiSettings.finalSystemDirective = panel.find('#qrf_final_system_directive').val();
            settings.apiSettings.rateMain = parseFloat(panel.find('#qrf_rate_main').val());
            settings.apiSettings.ratePersonal = parseFloat(panel.find('#qrf_rate_personal').val());
            settings.apiSettings.rateErotic = parseFloat(panel.find('#qrf_rate_erotic').val());
            settings.apiSettings.rateCuckold = parseFloat(panel.find('#qrf_rate_cuckold').val());

            // [核心修复] 实时从UI读取所有生成参数，确保所有模式都能使用最新值
            settings.apiSettings.max_tokens = parseInt(panel.find('#qrf_max_tokens').val(), 10);
            settings.apiSettings.temperature = parseFloat(panel.find('#qrf_temperature').val());
            settings.apiSettings.top_p = parseFloat(panel.find('#qrf_top_p').val());
            settings.apiSettings.presence_penalty = parseFloat(panel.find('#qrf_presence_penalty').val());
            settings.apiSettings.frequency_penalty = parseFloat(panel.find('#qrf_frequency_penalty').val());

            // [最终修复] 实时从UI读取世界书相关设置，完成所有参数的实时同步
            settings.apiSettings.worldbookEnabled = panel.find('#qrf_worldbook_enabled').is(':checked');
            settings.apiSettings.worldbookCharLimit = parseInt(panel.find('#qrf_worldbook_char_limit').val(), 10);
        }

        if (!settings.enabled || (settings.apiSettings.apiMode !== 'tavern' && !settings.apiSettings.apiUrl)) {
            return null; // 插件未启用，直接返回
        }

        $toast = toastr.info('正在规划剧情...', '剧情规划大师', { timeOut: 0, extendedTimeOut: 0 });

        const context = getContext();
        const character = characters[this_chid];
        const characterSettings = character?.data?.extensions?.[extension_name]?.apiSettings || {};
        const apiSettings = { ...settings.apiSettings, ...characterSettings };

        const contextTurnCount = apiSettings.contextTurnCount ?? 1;
        let slicedContext = [];
        if (contextTurnCount > 0) {
            // [修复] 修正上下文逻辑，确保只包含AI的回复，且数量由`contextTurnCount`控制。
            // 1. 从整个聊天记录中筛选出所有AI的回复。
            const aiHistory = context.chat.filter(msg => !msg.is_user);
            // 2. 从筛选后的历史中，截取最后N条AI的回复。
            const slicedAiHistory = aiHistory.slice(-contextTurnCount);
            
            slicedContext = slicedAiHistory.map(msg => ({ role: 'assistant', content: msg.mes }));
        }

        let worldbookContent = '';
        if (apiSettings.worldbookEnabled) {
            worldbookContent = await getCombinedWorldbookContent(context, apiSettings);
        }

        // [架构重构] 读取上一轮优化结果，用于$6占位符
        const lastPlotContent = getPlotFromHistory();

        let tableDataContent = '';
        try {
            if (window.stMemoryEnhancement && typeof window.stMemoryEnhancement.ext_exportAllTablesAsJson === 'function') {
                const tableDataJson = window.stMemoryEnhancement.ext_exportAllTablesAsJson();
                tableDataContent = formatTableDataForLLM(tableDataJson);
            } else {
                tableDataContent = '依赖的“记忆增强”插件未加载或版本不兼容。';
            }
        } catch (error) {
            console.error(`[${extension_name}] 处理记忆增强插件数据时出错:`, error);
            tableDataContent = '{"error": "加载表格数据时发生错误"}';
        }

        const replacements = {
            'sulv1': apiSettings.rateMain,
            'sulv2': apiSettings.ratePersonal,
            'sulv3': apiSettings.rateErotic,
            'sulv4': apiSettings.rateCuckold,
            '$5': tableDataContent,
            '$6': lastPlotContent, // [新增] 添加$6占位符及其内容
        };

        const processedPrompts = {
            mainPrompt: apiSettings.mainPrompt,
            systemPrompt: apiSettings.systemPrompt,
            finalSystemDirective: apiSettings.finalSystemDirective
        };

        for (const key in replacements) {
            const value = replacements[key];
            // [修复] 使用 escapeRegExp 来安全地处理像 $ 这样的特殊字符
            const regex = new RegExp(escapeRegExp(key), 'g');
            processedPrompts.mainPrompt = processedPrompts.mainPrompt.replace(regex, value);
            processedPrompts.systemPrompt = processedPrompts.systemPrompt.replace(regex, value);
            processedPrompts.finalSystemDirective = processedPrompts.finalSystemDirective.replace(regex, value);
        }

        const finalApiSettings = { ...apiSettings, ...processedPrompts };
        const minLength = settings.minLength || 0;
        let processedMessage = null;
        const maxRetries = 3;

        if (minLength > 0) {
            for (let i = 0; i < maxRetries; i++) {
                $toast.find('.toastr-message').text(`正在规划剧情... (尝试 ${i + 1}/${maxRetries})`);
                const tempMessage = await callInterceptionApi(userMessage, slicedContext, finalApiSettings, worldbookContent, tableDataContent);
                if (tempMessage && tempMessage.length >= minLength) {
                    processedMessage = tempMessage;
                    if ($toast) toastr.clear($toast);
                    toastr.success(`剧情规划成功 (第 ${i + 1} 次尝试)。`, '成功');
                    break;
                }
                if (i < maxRetries - 1) {
                    toastr.warning(`回复过短，准备重试...`, '剧情规划大师', { timeOut: 2000 });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } else {
            processedMessage = await callInterceptionApi(userMessage, slicedContext, finalApiSettings, worldbookContent, tableDataContent);
        }

        if (processedMessage) {
            // [架构重构] 将本次优化结果暂存，等待附加到新消息上
            tempPlotToSave = processedMessage;

            const finalSystemDirective = finalApiSettings.finalSystemDirective || '[SYSTEM_DIRECTIVE: You are a storyteller. The following <plot> block is your absolute script for this turn. You MUST follow the <directive> within it to generate the story.]';
            const finalMessage = `${userMessage}\n\n${finalSystemDirective}\n${processedMessage}`;
            if ($toast) toastr.clear($toast);
            if (minLength <= 0) {
                toastr.success('剧情规划大师已完成规划。', '规划成功');
            }
            return finalMessage;
        } else {
            if ($toast) toastr.clear($toast);
            if (minLength > 0) {
                toastr.error(`重试 ${maxRetries} 次后回复依然过短，操作已取消。`, '规划失败');
            }
            return null;
        }

    } catch (error) {
        console.error(`[${extension_name}] 在核心优化逻辑中发生错误:`, error);
        if ($toast) toastr.clear($toast);
        toastr.error('剧情规划大师在处理时发生错误。', '规划失败');
        return null;
    }
}


async function onGenerationAfterCommands(type, params, dryRun) {
    if (type === 'regenerate' || isProcessing || dryRun) {
        return;
    }

    // 仅处理来自主输入框的指令，脚本指令将由函数拦截器处理
    const textInBox = $('#send_textarea').val();
    if (!textInBox || textInBox.trim().length === 0) {
        return;
    }
    
    isProcessing = true;
    try {
        const finalMessage = await runOptimizationLogic(textInBox);

        if (finalMessage) {
            $('#send_textarea').val(finalMessage);
            $('#send_textarea').trigger('input');
        } else {
            // 失败时恢复原始输入
            $('#send_textarea').val(textInBox);
            $('#send_textarea').trigger('input');
        }
    } catch (error) {
        console.error(`[${extension_name}] 处理 onGenerationAfterCommands 事件时出错:`, error);
    } finally {
        isProcessing = false;
    }
}


function loadPluginStyles() {
    const styleId = `${extension_name}-style`;
    if (document.getElementById(styleId)) return;
    const styleUrl = `scripts/extensions/third-party/${extension_name}/style.css?v=${Date.now()}`;
    const linkElement = document.createElement('link');
    linkElement.id = styleId;
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    linkElement.href = styleUrl;
    document.head.appendChild(linkElement);
}

jQuery(async () => {
    // [彻底修复] 执行一个健壮的、非破坏性的设置初始化。
    // 此方法会保留所有用户已保存的设置，仅当设置项不存在时才从默认值中添加。
    if (!extension_settings[extension_name]) {
        extension_settings[extension_name] = {};
    }
    const settings = extension_settings[extension_name];

    // 确保 apiSettings 子对象存在
    if (!settings.apiSettings) {
        settings.apiSettings = {};
    }

    // 1. 遍历并应用顶层设置的默认值
    for (const key in defaultSettings) {
        if (key !== 'apiSettings' && settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }

    // 2. 遍历并应用 apiSettings 的默认值
    const defaultApiSettings = defaultSettings.apiSettings;
    for (const key in defaultApiSettings) {
        if (settings.apiSettings[key] === undefined) {
            settings.apiSettings[key] = defaultApiSettings[key];
        }
    }

    // 确保新增的顶层设置有默认值
    if (settings.minLength === undefined) {
        settings.minLength = 500;
    }

    const intervalId = setInterval(async () => {
        // [函数拦截] 确保 TavernHelper 可用后再执行拦截
        if ($('#extensions_settings').length > 0 && window.TavernHelper) {
            clearInterval(intervalId);
            try {
                loadPluginStyles();
                await createDrawer();

                // 备份原始函数
                if (!window.original_TavernHelper_generate) {
                    window.original_TavernHelper_generate = TavernHelper.generate;
                }

                // 创建并应用拦截器
                TavernHelper.generate = async function(...args) {
                    const options = args[0] || {};
                    
                    // 检查是否应该跳过优化：插件未启用、正在处理中、或这是一个流式请求
                    const settings = extension_settings[extension_name] || {};
                    if (!settings.enabled || isProcessing || options.should_stream) {
                        return window.original_TavernHelper_generate.apply(this, args);
                    }
                    
                    // [增强] 兼容不同调用方式，同时检查 injects (来自主UI) 和 user_input (来自扩展或脚本)
                    let userMessage = options.injects?.[0]?.content;
                    let isFromInjects = true;

                    if (!userMessage && options.user_input) {
                        userMessage = options.user_input;
                        isFromInjects = false;
                    }


                    if (userMessage) {
                        isProcessing = true;
                        try {
                            const finalMessage = await runOptimizationLogic(userMessage);
                            if (finalMessage) {
                                // 根据原始来源，将优化后的消息写回正确的位置
                                if (isFromInjects) {
                                    options.injects[0].content = finalMessage;
                                } else {
                                    options.user_input = finalMessage;
                                }
                            }
                            // 如果优化失败 (finalMessage is null)，则不修改参数，使用原始消息继续
                        } catch (error) {
                            console.error(`[${extension_name}] 在拦截器中执行优化时出错:`, error);
                        } finally {
                            isProcessing = false;
                        }
                    }

                    // 调用原始函数，传入可能已被修改的参数
                    return window.original_TavernHelper_generate.apply(this, args);
                };

                // 注册传统的事件监听器，作为对主输入框操作的补充和保障
                if (!window.qrfEventsRegistered) {
                    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
                    // [架构重构] 监听生成结束事件，以便将plot附加到新消息上
                    eventSource.on(event_types.GENERATION_ENDED, savePlotToLatestMessage);
                    window.qrfEventsRegistered = true;
                }

            } catch (error) {
                console.error(`[${extension_name}] 初始化或函数拦截过程中发生严重错误:`, error);
                // 如果拦截失败，尝试恢复原始函数
                if (window.original_TavernHelper_generate) {
                    TavernHelper.generate = window.original_TavernHelper_generate;
                }
            }
        }
    }, 100);
});
