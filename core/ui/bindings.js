// 剧情优化大师 - UI数据绑定模块
// 由Cline参照 '优化/' 插件的健壮性实践重构

import { extension_settings, getContext } from '/scripts/extensions.js';
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { eventSource, event_types } from '/script.js';
import { extensionName, defaultSettings } from '../utils/settings.js';
import { fetchModels, testApiConnection } from '../core/api.js';

/**
 * 手动触发所有设置的保存。
 * 这对于在关闭面板等事件时确保数据被保存非常有用。
 */
export function saveAllSettings() {
    const panel = $('#qrf_settings_panel');
    if (panel.length === 0) return;

    console.log(`[${extensionName}] 手动触发所有设置的保存...`);
    
    // 触发所有相关输入元素的change事件，以利用现有的保存逻辑
    panel.find('input[type="checkbox"], input[type="radio"], input[type="text"], input[type="password"], textarea, select').trigger('change.qrf');
    
    // 对于滑块，input事件可能更合适，但change也应在值改变后触发
    panel.find('input[type="range"]').trigger('change.qrf');
    
    // 确保世界书条目也被保存
    saveEnabledEntries();
    
    toastr.info('设置已自动保存。');
}


/**
 * 将下划线或连字符命名的字符串转换为驼峰命名。
 * e.g., 'qrf_api_url' -> 'qrfApiUrl'
 * @param {string} str - 输入字符串。
 * @returns {string} - 驼峰格式字符串。
 */
function toCamelCase(str) {
    return str.replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
}

/**
 * 根据选择的API模式，更新URL输入框的可见性并自动填充URL。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} apiMode - 当前选择的API模式 ('backend', 'frontend', 或 'google')。
 */
function updateApiUrlVisibility(panel, apiMode) {
    const customApiSettings = panel.find('#qrf_custom_api_settings_block');
    const tavernProfileSettings = panel.find('#qrf_tavern_api_profile_block');
    const apiUrlInput = panel.find('#qrf_api_url');
    
    // Hide all blocks first
    customApiSettings.hide();
    tavernProfileSettings.hide();

    if (apiMode === 'tavern') {
        tavernProfileSettings.show();
    } else {
        customApiSettings.show();
        if (apiMode === 'google') {
            panel.find('#qrf_api_url_block').hide();
            const googleUrl = 'https://generativelanguage.googleapis.com';
            if (apiUrlInput.val() !== googleUrl) {
                apiUrlInput.val(googleUrl).trigger('change');
            }
        } else {
            panel.find('#qrf_api_url_block').show();
        }
    }
}

/**
 * 根据选择的世界书来源，显示或隐藏手动选择区域。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} source - 当前选择的来源 ('character' or 'manual')。
 */
function updateWorldbookSourceVisibility(panel, source) {
    const manualSelectionWrapper = panel.find('#qrf_worldbook_select_wrapper');
    if (source === 'manual') {
        manualSelectionWrapper.show();
    } else {
        manualSelectionWrapper.hide();
    }
}

/**
 * 加载SillyTavern的API连接预设到下拉菜单。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
async function loadTavernApiProfiles(panel) {
    const select = panel.find('#qrf_tavern_api_profile_select');
    const apiSettings = getMergedApiSettings();
    const currentProfileId = apiSettings.tavernProfile;
    
    // 保存当前值，清空并添加默认选项
    const currentValue = select.val();
    select.empty().append(new Option('-- 请选择一个酒馆预设 --', ''));

    try {
        const tavernProfiles = getContext().extensionSettings?.connectionManager?.profiles || [];
        if (!tavernProfiles || tavernProfiles.length === 0) {
            select.append($('<option>', { value: '', text: '未找到酒馆预设', disabled: true }));
            return;
        }

        let foundCurrentProfile = false;
        tavernProfiles.forEach(profile => {
            if (profile.api && profile.preset) { // 确保是有效的API预设
                const option = $('<option>', {
                    value: profile.id,
                    text: profile.name || profile.id,
                    selected: profile.id === currentProfileId
                });
                select.append(option);
                if (profile.id === currentProfileId) {
                    foundCurrentProfile = true;
                }
            }
        });

        // 如果之前保存的ID无效了，给出提示
        if (currentProfileId && !foundCurrentProfile) {
            toastr.warning(`之前选择的酒馆预设 "${currentProfileId}" 已不存在，请重新选择。`);
            saveSetting('tavernProfile', '');
        } else if (foundCurrentProfile) {
             select.val(currentProfileId);
        }

    } catch (error) {
        console.error(`[${extensionName}] 加载酒馆API预设失败:`, error);
        toastr.error('无法加载酒馆API预设列表，请查看控制台。');
    }
}


/**
 * 根据选择的世界书来源，显示或隐藏手动选择区域。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} source - 当前选择的来源 ('character' or 'manual')。
 */
// ---- 新的、支持角色卡独立配置的设置保存/加载逻辑 ----

// 需要保存到角色卡的设置项列表
const characterSpecificSettings = [
    'worldbookSource',
    'selectedWorldbooks',
    'enabledWorldbookEntries'
];

/**
 * 保存单个设置项。
 * 根据设置项的键名，决定是保存到全局设置还是当前角色卡。
 * @param {string} key - 设置项的键（驼峰式）。
 * @param {*} value - 设置项的值。
 */
async function saveSetting(key, value) {
    if (characterSpecificSettings.includes(key)) {
        // --- 保存到角色卡 ---
        const character = characters[this_chid];
        if (!character) {
            // 在没有角色卡的情况下，静默失败，不保存角色特定设置
            return;
        }

        if (!character.data.extensions) character.data.extensions = {};
        if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};
        if (!character.data.extensions[extensionName].apiSettings) character.data.extensions[extensionName].apiSettings = {};
        
        character.data.extensions[extensionName].apiSettings[key] = value;
        
        // 使用SillyTavern的API来异步保存角色数据
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: character.data.extensions[extensionName] } }
                })
            });

            if (!response.ok) {
                throw new Error(`API call failed with status: ${response.status}`);
            }
            console.log(`[${extensionName}] 角色卡设置已更新: ${key} ->`, value);
        } catch (error) {
            console.error(`[${extensionName}] 保存角色数据失败:`, error);
            toastr.error('无法保存角色卡设置，请检查控制台。');
        }

    } else {
        // --- 保存到全局设置 (旧逻辑) ---
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        
        const apiSettingKeys = Object.keys(defaultSettings.apiSettings);
        if (apiSettingKeys.includes(key)) {
            if (!extension_settings[extensionName].apiSettings) {
                extension_settings[extensionName].apiSettings = {};
            }
            extension_settings[extensionName].apiSettings[key] = value;
        } else {
            extension_settings[extensionName][key] = value;
        }

        console.log(`[${extensionName}] 全局设置已更新: ${key} ->`, value);
        saveSettingsDebounced();
    }
}


/**
 * 获取合并后的设置对象。
 * 以全局设置为基础，然后用当前角色卡的设置覆盖它。
 * @returns {object} - 合并后的apiSettings对象。
 */
function getMergedApiSettings() {
    const character = characters[this_chid];
    const globalSettings = extension_settings[extensionName]?.apiSettings || defaultSettings.apiSettings;
    const characterSettings = character?.data?.extensions?.[extensionName]?.apiSettings || {};
    
    return { ...globalSettings, ...characterSettings };
}

/**
 * [新增] 清除当前角色卡上所有陈旧的、与提示词相关的设置。
 * 这是为了防止旧的角色卡数据覆盖新加载的全局预设。
 */
/**
 * [新增] 清除当前角色卡上所有陈旧的、本应是全局的设置。
 * 这是为了防止旧的角色卡数据覆盖新的全局设置。
 * @param {'prompts' | 'api'} type - 要清除的设置类型。
 */
async function clearCharacterStaleSettings(type) {
    const character = characters[this_chid];
    if (!character?.data?.extensions?.[extensionName]?.apiSettings) {
        return; // 没有角色或没有设置可清除。
    }

    const charApiSettings = character.data.extensions[extensionName].apiSettings;
    let keysToClear = [];
    let message = '';

    if (type === 'prompts') {
        keysToClear = ['mainPrompt', 'systemPrompt', 'finalSystemDirective', 'rateMain', 'ratePersonal', 'rateErotic', 'rateCuckold'];
        message = '陈旧提示词设置';
    } else if (type === 'api') {
        // 清除所有非角色特定的API设置
        const allApiKeys = Object.keys(defaultSettings.apiSettings);
        keysToClear = allApiKeys.filter(key => !characterSpecificSettings.includes(key));
        message = '陈旧API连接设置';
    }

    if (keysToClear.length === 0) return;

    let settingsCleared = false;
    keysToClear.forEach(key => {
        if (charApiSettings[key] !== undefined) {
            delete charApiSettings[key];
            settingsCleared = true;
        }
    });

    if (settingsCleared) {
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: { apiSettings: charApiSettings } } }
                })
            });
            if (!response.ok) throw new Error(`API call failed with status: ${response.status}`);
            console.log(`[${extensionName}] 已成功清除当前角色卡的${message}。`);
            toastr.info(`已清除角色卡上的${message}。`);
        } catch (error) {
            console.error(`[${extensionName}] 清除角色${message}失败:`, error);
            toastr.error(`无法清除角色卡上的${message}。`);
        }
    }
}



// ---- 世界书逻辑 ----
async function loadWorldbooks(panel) {
    const select = panel.find('#qrf_selected_worldbooks');
    const apiSettings = getMergedApiSettings(); // 使用合并后的设置
    const currentSelection = apiSettings.selectedWorldbooks || [];
    select.empty();

    try {
        const lorebooks = await window.TavernHelper.getLorebooks();
        if (!lorebooks || lorebooks.length === 0) {
            select.append($('<option>', { value: '', text: '未找到世界书', disabled: true }));
            return;
        }

        lorebooks.forEach(name => {
            const option = $('<option>', {
                value: name,
                text: name,
                selected: currentSelection.includes(name)
            });
            select.append(option);
        });
    } catch (error) {
        console.error(`[${extensionName}] 加载世界书失败:`, error);
        toastr.error('无法加载世界书列表，请查看控制台。');
    }
}

async function loadWorldbookEntries(panel) {
    const container = panel.find('#qrf_worldbook_entry_list_container');
    const countDisplay = panel.find('#qrf_worldbook_entry_count');
    container.html('<p>加载条目中...</p>');
    countDisplay.text('');

    const apiSettings = getMergedApiSettings(); // 使用合并后的设置
    const currentSource = apiSettings.worldbookSource || 'character';
    let bookNames = [];

    if (currentSource === 'manual') {
        bookNames = apiSettings.selectedWorldbooks || [];
    } else {
        // 修复：在尝试获取角色世界书之前，先检查是否已加载角色
        if (this_chid === -1 || !characters[this_chid]) {
            container.html('<p class="notes">未选择角色。</p>');
            countDisplay.text('');
            return; // 没有角色，直接返回，不弹窗
        }
        try {
            const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        } catch (error) {
            // 只有在确实有角色但加载失败时才报错
            console.error(`[${extensionName}] 获取角色世界书失败:`, error);
            toastr.error('获取角色世界书失败。');
            container.html('<p class="notes" style="color:red;">获取角色世界书失败。</p>');
            return;
        }
    }

    const selectedBooks = bookNames;
    let enabledEntries = apiSettings.enabledWorldbookEntries || {};
    let totalEntries = 0;
    let visibleEntries = 0;

    if (selectedBooks.length === 0) {
        container.html('<p class="notes">请选择一个或多个世界书以查看其条目。</p>');
        return;
    }

    try {
        const allEntries = [];
        for (const bookName of selectedBooks) {
            const entries = await window.TavernHelper.getLorebookEntries(bookName);
            entries.forEach(entry => {
                allEntries.push({ ...entry, bookName });
            });
        }

        container.empty();
        totalEntries = allEntries.length;

        if (totalEntries === 0) {
            container.html('<p class="notes">所选世界书没有条目。</p>');
            countDisplay.text('0 条目.');
            return;
        }

        allEntries.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')).forEach(entry => {
            // [核心优化] 如果条目在SillyTavern中是关闭的，则直接跳过，不在UI中显示
            if (!entry.enabled) return;

            const entryId = `qrf-entry-${entry.bookName.replace(/[^a-zA-Z0-9]/g, '-')}-${entry.uid}`;
            // [修复] 优化加载逻辑：仅当一个世界书的设置完全不存在时，才默认启用其条目。
            // 否则，严格按照已保存的设置来决定是否勾选。
            const isEnabled = (enabledEntries[entry.bookName] === undefined) || (enabledEntries[entry.bookName]?.includes(entry.uid));

            const item = $(`
                <div class="qrf_worldbook_entry_item">
                    <input type="checkbox" id="${entryId}" data-book="${entry.bookName}" data-uid="${entry.uid}" ${isEnabled ? 'checked' : ''}>
                    <label for="${entryId}" title="世界书: ${entry.bookName}\nUID: ${entry.uid}">${entry.comment || '无标题条目'}</label>
                </div>
            `);
            container.append(item);
        });
        
        visibleEntries = container.children().length;
        countDisplay.text(`显示 ${visibleEntries} / ${totalEntries} 条目.`);

    } catch (error) {
        console.error(`[${extensionName}] 加载世界书条目失败:`, error);
        container.html('<p class="notes" style="color:red;">加载条目失败。</p>');
    }
}


function saveEnabledEntries() {
    const panel = $('#qrf_settings_panel');
    let enabledEntries = {};

    panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').each(function() {
        const bookName = $(this).data('book');
        const uid = parseInt($(this).data('uid'));

        if (!enabledEntries[bookName]) {
            enabledEntries[bookName] = [];
        }

        if ($(this).is(':checked')) {
            enabledEntries[bookName].push(uid);
        }
    });
    
    const apiSettings = getMergedApiSettings();
    
    if (apiSettings.worldbookSource === 'manual') {
        const selectedBooks = apiSettings.selectedWorldbooks || [];
        Object.keys(enabledEntries).forEach(bookName => {
            if (!selectedBooks.includes(bookName)) {
                delete enabledEntries[bookName];
            }
        });
    }

    saveSetting('enabledWorldbookEntries', enabledEntries);
}

/**
 * 加载并填充提示词预设到下拉菜单。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadPromptPresets(panel) {
    const presets = extension_settings[extensionName]?.promptPresets || [];
    const select = panel.find('#qrf_prompt_preset_select');

    const currentValue = select.val();
    select.empty().append(new Option('-- 选择一个预设 --', ''));

    presets.forEach(preset => {
        select.append(new Option(preset.name, preset.name));
    });

    // 仅恢复选择，不触发change或显示按钮，这些由其他逻辑处理
    if (currentValue && presets.some(p => p.name === currentValue)) {
        select.val(currentValue);
    }
}

/**
 * 交互式地保存一个新的或覆盖一个现有的提示词预设 (用于“另存为”功能)。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function saveAsNewPreset(panel) {
    const presetName = prompt("请输入新预设的名称：");
    if (!presetName) return;

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === presetName);

    const newPresetData = {
        name: presetName,
        mainPrompt: panel.find('#qrf_main_prompt').val(),
        systemPrompt: panel.find('#qrf_system_prompt').val(),
        finalSystemDirective: panel.find('#qrf_final_system_directive').val(),
        rateMain: parseFloat(panel.find('#qrf_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#qrf_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#qrf_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#qrf_rate_cuckold').val())
    };

    if (existingPresetIndex !== -1) {
        if (confirm(`名为 "${presetName}" 的预设已存在。是否要覆盖它？`)) {
            presets[existingPresetIndex] = newPresetData;
            toastr.success(`预设 "${presetName}" 已被覆盖。`);
        } else {
            toastr.info('保存操作已取消。');
            return;
        }
    } else {
        presets.push(newPresetData);
        toastr.success(`新预设 "${presetName}" 已保存。`);
    }
    saveSetting('promptPresets', presets);

    loadPromptPresets(panel);
    setTimeout(() => {
        panel.find('#qrf_prompt_preset_select').val(presetName).trigger('change');
    }, 0);
}


/**
 * 覆盖当前选中的提示词预设 (用于“保存”功能)。
 * 如果没有预设被选中，则行为与“另存为”相同。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function overwriteSelectedPreset(panel) {
    const select = panel.find('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        // 如果没有选择预设，则“保存”应等同于“另存为”
        saveAsNewPreset(panel);
        return;
    }

    if (!confirm(`确定要用当前设置覆盖预设 "${selectedName}" 吗？`)) {
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === selectedName);

    if (existingPresetIndex === -1) {
        toastr.error('找不到要覆盖的预设，它可能已被删除。');
        return;
    }
    
    const updatedPresetData = {
        name: selectedName,
        mainPrompt: panel.find('#qrf_main_prompt').val(),
        systemPrompt: panel.find('#qrf_system_prompt').val(),
        finalSystemDirective: panel.find('#qrf_final_system_directive').val(),
        rateMain: parseFloat(panel.find('#qrf_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#qrf_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#qrf_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#qrf_rate_cuckold').val())
    };

    presets[existingPresetIndex] = updatedPresetData;
    saveSetting('promptPresets', presets);
    toastr.success(`预设 "${selectedName}" 已被成功覆盖。`);
}

/**
 * 删除当前选中的提示词预设。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function deleteSelectedPreset(panel) {
    const select = panel.find('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.warning('没有选择任何预设。');
        return;
    }

    if (!confirm(`确定要删除预设 "${selectedName}" 吗？`)) {
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    // 修正: 使用 splice 直接修改原数组，而不是创建新数组，以确保UI能正确更新
    const indexToDelete = presets.findIndex(p => p.name === selectedName);

    if (indexToDelete > -1) {
        presets.splice(indexToDelete, 1);
        saveSetting('promptPresets', presets);
        toastr.success(`预设 "${selectedName}" 已被删除。`);
    } else {
        toastr.error('找不到要删除的预设，操作可能已过期。');
    }

    // 刷新UI
    loadPromptPresets(panel);
    // 触发change以更新删除按钮状态并清除lastUsed
    select.trigger('change');
}

/**
 * 导出当前选中的提示词预设到一个JSON文件。
 */
function exportPromptPresets() {
    const select = $('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.info('请先从下拉菜单中选择一个要导出的预设。');
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const selectedPreset = presets.find(p => p.name === selectedName);

    if (!selectedPreset) {
        toastr.error('找不到选中的预设，请刷新页面后重试。');
        return;
    }

    // 为了兼容导入逻辑，我们始终导出一个包含单个对象的数组
    const dataToExport = [selectedPreset];
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    // 使用预设名作为文件名
    a.download = `qrf_preset_${selectedName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`预设 "${selectedName}" 已成功导出。`);
}

/**
 * 从一个JSON文件导入提示词预设。
 * @param {File} file - 用户选择的JSON文件。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function importPromptPresets(file, panel) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedPresets = JSON.parse(e.target.result);

            if (!Array.isArray(importedPresets)) {
                throw new Error('JSON文件格式不正确，根节点必须是一个数组。');
            }

            let currentPresets = extension_settings[extensionName]?.promptPresets || [];
            let importedCount = 0;
            let overwrittenCount = 0;

            importedPresets.forEach(preset => {
                if (preset && typeof preset.name === 'string' && preset.name.length > 0) {
                    const presetData = {
                        name: preset.name,
                        mainPrompt: preset.mainPrompt || '',
                        systemPrompt: preset.systemPrompt || '',
                        finalSystemDirective: preset.finalSystemDirective || '',
                        rateMain: preset.rateMain ?? 1.0,
                        ratePersonal: preset.ratePersonal ?? 1.0,
                        rateErotic: preset.rateErotic ?? 1.0,
                        rateCuckold: preset.rateCuckold ?? 1.0
                    };

                    const existingIndex = currentPresets.findIndex(p => p.name === preset.name);

                    if (existingIndex !== -1) {
                        // 覆盖现有预设
                        currentPresets[existingIndex] = presetData;
                        overwrittenCount++;
                    } else {
                        // 添加新预设
                        currentPresets.push(presetData);
                        importedCount++;
                    }
                }
            });

            if (importedCount > 0 || overwrittenCount > 0) {
                const selectedPresetBeforeImport = panel.find('#qrf_prompt_preset_select').val();
                
                saveSetting('promptPresets', currentPresets);
                loadPromptPresets(panel);
                
                // 重新选中导入前选中的预设（如果它还存在的话），并强制触发change事件来刷新UI
                panel.find('#qrf_prompt_preset_select').val(selectedPresetBeforeImport);
                panel.find('#qrf_prompt_preset_select').trigger('change');

                let messages = [];
                if (importedCount > 0) messages.push(`成功导入 ${importedCount} 个新预设。`);
                if (overwrittenCount > 0) messages.push(`成功覆盖 ${overwrittenCount} 个同名预设。`);
                toastr.success(messages.join(' '));
            } else {
                toastr.warning('未找到可导入的有效预设。');
            }

        } catch (error) {
            console.error(`[${extensionName}] 导入预设失败:`, error);
            toastr.error(`导入失败: ${error.message}`, '错误');
        } finally {
            // 清空文件输入框的值，以便可以再次选择同一个文件
            panel.find('#qrf_preset_file_input').val('');
        }
    };
    reader.readAsText(file);
}

/**
 * 加载设置到UI界面。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadSettings(panel) {
    // 全局设置只用于非角色绑定的部分
    const globalSettings = extension_settings[extensionName] || defaultSettings;
    // API设置从合并后的来源获取
    const apiSettings = getMergedApiSettings();

    // 加载总开关 (全局)
    panel.find('#qrf_enabled').prop('checked', globalSettings.enabled);
    panel.find('#qrf_min_length').val(globalSettings.minLength ?? 500);

    // 加载API和模型设置 (大部分是全局，但世界书相关是角色卡)
    panel.find(`input[name="qrf_api_mode"][value="${apiSettings.apiMode}"]`).prop('checked', true);
    panel.find('#qrf_tavern_api_profile_select').val(apiSettings.tavernProfile); // 加载酒馆预设选择
    panel.find(`input[name="qrf_worldbook_source"][value="${apiSettings.worldbookSource || 'character'}"]`).prop('checked', true);
    panel.find('#qrf_worldbook_enabled').prop('checked', apiSettings.worldbookEnabled);
    panel.find('#qrf_api_url').val(apiSettings.apiUrl);
    panel.find('#qrf_api_key').val(apiSettings.apiKey);
    
    const modelInput = panel.find('#qrf_model');
    const modelSelect = panel.find('#qrf_model_select');
    
    modelInput.val(apiSettings.model);
    modelSelect.empty();
    if (apiSettings.model) {
        modelSelect.append(new Option(apiSettings.model, apiSettings.model, true, true));
    } else {
        modelSelect.append(new Option('<-请先获取模型', '', true, true));
    }

    panel.find('#qrf_max_tokens').val(apiSettings.maxTokens);
    panel.find('#qrf_temperature').val(apiSettings.temperature);
    panel.find('#qrf_top_p').val(apiSettings.topP);
    panel.find('#qrf_presence_penalty').val(apiSettings.presencePenalty);
    panel.find('#qrf_frequency_penalty').val(apiSettings.frequencyPenalty);
    panel.find('#qrf_context_turn_count').val(apiSettings.contextTurnCount);
    panel.find('#qrf_worldbook_char_limit').val(apiSettings.worldbookCharLimit);

    // 加载匹配替换速率
    panel.find('#qrf_rate_main').val(apiSettings.rateMain);
    panel.find('#qrf_rate_personal').val(apiSettings.ratePersonal);
    panel.find('#qrf_rate_erotic').val(apiSettings.rateErotic);
    panel.find('#qrf_rate_cuckold').val(apiSettings.rateCuckold);

    // 加载提示词
    panel.find('#qrf_main_prompt').val(apiSettings.mainPrompt);
    panel.find('#qrf_system_prompt').val(apiSettings.systemPrompt);
    panel.find('#qrf_final_system_directive').val(apiSettings.finalSystemDirective);

    updateApiUrlVisibility(panel, apiSettings.apiMode);
    updateWorldbookSourceVisibility(panel, apiSettings.worldbookSource || 'character');
    
    // 加载提示词预-设
    loadPromptPresets(panel);

    // 自动选择上次使用的预设 (全局)
    const lastUsedPresetName = globalSettings.lastUsedPresetName;
    if (lastUsedPresetName && (globalSettings.promptPresets || []).some(p => p.name === lastUsedPresetName)) {
        // 使用setTimeout确保下拉列表已完全填充
        setTimeout(() => {
            // 传递一个额外参数来标记这是自动触发的，以避免显示通知
            panel.find('#qrf_prompt_preset_select').val(lastUsedPresetName).trigger('change', { isAutomatic: true });
        }, 0);
    }
    
    // 加载世界书和条目 (使用角色卡设置)
    loadWorldbooks(panel).then(() => {
        loadWorldbookEntries(panel);
    });
    
    // 加载酒馆API预设
    loadTavernApiProfiles(panel);
}

/**
 * 为设置面板绑定所有事件。
 */
export function initializeBindings() {
    const panel = $('#qrf_settings_panel');
    if (panel.length === 0 || panel.data('events-bound')) {
        return;
    }
    
    loadSettings(panel);

    // 监听角色切换事件，刷新UI
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log(`[${extensionName}] 检测到角色/聊天切换，正在刷新设置UI...`);
        loadSettings(panel);
    });

    // --- 事件绑定区域 (智能保存) ---

    // 优化1: 创建一个统一的保存处理器，以避免代码重复
    const handleSettingChange = function(element) {
        const el = $(element);
        let key;
        
        if (element.name === 'qrf_worldbook_source') {
            key = 'worldbookSource';
        } else {
            key = toCamelCase((element.name || element.id).replace('qrf_', ''));
        }
        
        let value = element.type === 'checkbox' ? element.checked : el.val();

        if (key === 'selectedWorldbooks' && !Array.isArray(value)) {
            value = el.val() || [];
        }
        
        const floatKeys = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'rateMain', 'ratePersonal', 'rateErotic', 'rateCuckold'];
        if (floatKeys.includes(key) && value !== '') {
            value = parseFloat(value);
        } else if (element.type === 'range' || element.type === 'number') {
            if (value !== '') value = parseInt(value, 10);
        }
        
        if (value !== '' || element.type === 'checkbox') {
             saveSetting(key, value);
        }

        if (element.name === 'qrf_api_mode') {
            updateApiUrlVisibility(panel, value);
            // [核心修复] 切换API模式时，清除所有旧的、非角色特定的API设置
            clearCharacterStaleSettings('api');
        }
        if (element.name === 'qrf_worldbook_source') {
            updateWorldbookSourceVisibility(panel, value);
            loadWorldbookEntries(panel);
        }
    };

    // 优化2: 统一所有输入控件的事件绑定，实现更简洁、更一致的实时保存
    const allInputSelectors = [
        'input[type="checkbox"]', 'input[type="radio"]', 'select:not(#qrf_model_select)',
        'input[type="text"]', 'input[type="password"]', 'textarea',
        'input[type="range"]', 'input[type="number"]'
    ].join(', ');

    // 使用 'input' 和 'change' 事件确保覆盖所有交互场景：
    // - 'input' 实时捕捉打字、拖动等操作。
    // - 'change' 捕捉点击选择、粘贴、自动填充等操作。
    panel.on('input.qrf change.qrf', allInputSelectors, function() {
        handleSettingChange(this);
    });

    // 特殊处理模型选择下拉框
    panel.on('change.qrf', '#qrf_model_select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            // 手动触发模型输入框的change，会由上面的监听器捕获并保存
            panel.find('#qrf_model').val(selectedModel).trigger('change');
        }
    });

    // --- 功能按钮事件 ---

    panel.find('#qrf_fetch_models').on('click', async function () {
        const button = $(this);
        // 修正: 从UI实时获取apiMode，以进行正确的逻辑判断
        const apiMode = panel.find('input[name="qrf_api_mode"]:checked').val();

        if (apiMode === 'tavern') {
            toastr.info('在“使用酒馆连接预设”模式下，模型已在预设中定义，无需单独获取。');
            return;
        }

        button.prop('disabled', true).find('i').addClass('fa-spin');
        
        // 修正: 确保传递给fetchModels的设置是最新的
        const apiSettings = getMergedApiSettings();
        const currentApiSettings = {
            ...apiSettings,
            apiUrl: panel.find('#qrf_api_url').val(),
            apiKey: panel.find('#qrf_api_key').val(),
            model: panel.find('#qrf_model').val(),
            apiMode: apiMode // 传递实时获取的apiMode
        };

        const models = await fetchModels(currentApiSettings);
        const modelSelect = panel.find('#qrf_model_select');
        modelSelect.empty().append(new Option('请选择一个模型', ''));
        
        if (models && models.length > 0) {
            models.forEach(model => modelSelect.append(new Option(model.id || model.model, model.id || model.model)));
            if (currentApiSettings.model && modelSelect.find(`option[value="${currentApiSettings.model}"]`).length > 0) {
                modelSelect.val(currentApiSettings.model);
            }
        } else {
             toastr.info('未能获取到模型列表，您仍然可以手动输入模型名称。');
        }
        
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    panel.find('#qrf_test_api').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true).find('i').addClass('fa-spin');
        const apiSettings = getMergedApiSettings();
        // 修正: 直接从UI读取最新的API URL, Key和模型, 避免因设置未保存导致测试失败的问题
        const currentApiSettings = {
            ...apiSettings,
            apiUrl: panel.find('#qrf_api_url').val(),
            apiKey: panel.find('#qrf_api_key').val(),
            model: panel.find('#qrf_model').val(),
            apiMode: panel.find('input[name="qrf_api_mode"]:checked').val(), // 实时获取当前API模式
            // 确保测试时也传递 tavernProfile
            tavernProfile: panel.find('#qrf_tavern_api_profile_select').val()
        };
        await testApiConnection(currentApiSettings);
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    // 绑定酒馆API预设刷新按钮
    panel.on('click.qrf', '#qrf_refresh_tavern_api_profiles', () => {
        loadTavernApiProfiles(panel);
    });

    // 绑定酒馆API预设选择事件
    panel.on('change.qrf', '#qrf_tavern_api_profile_select', function() {
        const value = $(this).val();
        saveSetting('tavernProfile', value);
    });

    // --- 提示词预设功能 ---

    panel.find('#qrf_import_prompt_presets').on('click', () => panel.find('#qrf_preset_file_input').click());
    panel.find('#qrf_export_prompt_presets').on('click', () => exportPromptPresets());
    panel.find('#qrf_save_prompt_preset').on('click', () => overwriteSelectedPreset(panel));
    panel.find('#qrf_save_as_new_prompt_preset').on('click', () => saveAsNewPreset(panel));
    panel.find('#qrf_delete_prompt_preset').on('click', () => deleteSelectedPreset(panel));

    panel.on('change.qrf', '#qrf_preset_file_input', function(e) {
        importPromptPresets(e.target.files[0], panel);
    });

    panel.on('change.qrf', '#qrf_prompt_preset_select', function(event, data) {
        const selectedName = $(this).val();
        const deleteBtn = panel.find('#qrf_delete_prompt_preset');
        const isAutomatic = data && data.isAutomatic; // 检查是否是自动触发
        
        // 保存当前选择
        saveSetting('lastUsedPresetName', selectedName);

        if (!selectedName) {
            deleteBtn.hide();
            // 如果取消选择，也清空上次选择的记录
            saveSetting('lastUsedPresetName', '');
            return;
        }

        const presets = extension_settings[extensionName]?.promptPresets || [];
        const selectedPreset = presets.find(p => p.name === selectedName);

        if (selectedPreset) {
            // [最终修复] 加载预设时，通过触发每个元素的change事件来保存，
            // 确保保存逻辑(包括命名转换)与用户手动修改时完全一致。
            panel.find('#qrf_main_prompt').val(selectedPreset.mainPrompt).trigger('change');
            panel.find('#qrf_system_prompt').val(selectedPreset.systemPrompt).trigger('change');
            panel.find('#qrf_final_system_directive').val(selectedPreset.finalSystemDirective).trigger('change');
            
            panel.find('#qrf_rate_main').val(selectedPreset.rateMain ?? 1.0).trigger('change');
            panel.find('#qrf_rate_personal').val(selectedPreset.ratePersonal ?? 1.0).trigger('change');
            panel.find('#qrf_rate_erotic').val(selectedPreset.rateErotic ?? 1.0).trigger('change');
            panel.find('#qrf_rate_cuckold').val(selectedPreset.rateCuckold ?? 1.0).trigger('change');

            // [核心修复] 清除角色卡上可能存在的、会覆盖全局预设的陈旧设置
            clearCharacterStaleSettings('prompts');

            // 只有在非自动触发时才显示通知
            if (!isAutomatic) {
                toastr.success(`已加载预设 "${selectedName}"。`);
            }
            deleteBtn.show();
        } else {
            deleteBtn.hide();
        }
    });

    // --- 重置按钮事件 ---

    panel.find('#qrf_reset_main_prompt').on('click', function() {
        panel.find('#qrf_main_prompt').val(defaultSettings.apiSettings.mainPrompt).trigger('change');
        toastr.success('主提示词已重置为默认值。');
    });

    panel.find('#qrf_reset_system_prompt').on('click', function() {
        panel.find('#qrf_system_prompt').val(defaultSettings.apiSettings.systemPrompt).trigger('change');
        toastr.success('拦截任务指令已重置为默认值。');
    });

    panel.find('#qrf_reset_final_system_directive').on('click', function() {
        panel.find('#qrf_final_system_directive').val(defaultSettings.apiSettings.finalSystemDirective).trigger('change');
        toastr.success('最终注入指令已重置为默认值。');
    });

    panel.data('events-bound', true);
    console.log(`[${extensionName}] UI事件已成功绑定，自动保存已激活。`);

    // ---- 世界书事件绑定 ----
    panel.on('click.qrf', '#qrf_refresh_worldbooks', () => {
        loadWorldbooks(panel).then(() => {
            loadWorldbookEntries(panel);
        });
    });

    panel.on('change.qrf', '#qrf_selected_worldbooks', async function() {
        const selected = $(this).val() || [];
        // 强制等待设置保存完成，再执行加载，避免竞态条件
        await saveSetting('selectedWorldbooks', selected);
        await loadWorldbookEntries(panel);
    });

    panel.on('change.qrf', '#qrf_worldbook_entry_list_container input[type="checkbox"]', () => {
        saveEnabledEntries();
    });

    panel.on('click.qrf', '#qrf_worldbook_entry_select_all', () => {
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').prop('checked', true);
        saveEnabledEntries();
    });

    panel.on('click.qrf', '#qrf_worldbook_entry_deselect_all', () => {
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').prop('checked', false);
        saveEnabledEntries();
    });
}
