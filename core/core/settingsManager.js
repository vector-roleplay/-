// 剧情规划大师 - 设置管理模块
// [新增] 这是一个全新的模块，用于集中处理所有设置的加载、合并和保存逻辑。

import { extension_settings, getContext } from '/scripts/extensions.js';
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { extensionName, getDefaultSettings, isCharacterSpecificSetting, isApiSetting } from '../utils/settings.js';

/**
 * [重构] 获取最终生效的设置对象。
 * 这是插件获取配置的唯一入口。它会执行深度合并：
 * 默认设置 <— 全局设置 <— 角色卡设置
 * @returns {object} - 一个包含所有合并后设置的完整对象。
 */
export function getSettings() {
    const defaults = getDefaultSettings();
    const character = characters[this_chid];

    // 1. 从SillyTavern加载已保存的全局设置
    const savedGlobals = _.cloneDeep(extension_settings[extensionName] || {});

    // 2. 从SillyTavern加载已保存的角色卡设置
    const savedCharacterSpecifics = _.cloneDeep(character?.data?.extensions?.[extensionName] || {});
    
    // 3. 执行深度合并
    const globalSettings = _.merge({}, defaults.global, savedGlobals);
    const characterSettings = _.merge({}, defaults.character, savedCharacterSpecifics);
    
    // 4. 将角色设置合并到全局apiSettings的一个副本上，以产生最终生效的api设置
    const finalApiSettings = _.merge({}, globalSettings.apiSettings, characterSettings);

    return {
        ...globalSettings,
        ...characterSettings, // 将角色设置也提升到顶层，便于访问
        apiSettings: finalApiSettings, // 使用合并后的apiSettings
    };
}


/**
 * [重构] 保存单个设置项。
 * 它会自动判断应该将设置保存到全局还是角色卡。
 * @param {string} key - The setting key (camelCase).
 * @param {*} value - The value to save.
 */
export async function saveSetting(key, value) {
    if (isCharacterSpecificSetting(key)) {
        await saveCharacterSetting(key, value);
    } else {
        await saveGlobalSetting(key, value);
    }
}

/**
 * [新增] 专门用于保存全局设置的函数。
 * @param {string} key - The setting key.
 * @param {*} value - The value to save.
 */
async function saveGlobalSetting(key, value) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }

    if (isApiSetting(key)) {
        if (!extension_settings[extensionName].apiSettings) {
            extension_settings[extensionName].apiSettings = {};
        }
        extension_settings[extensionName].apiSettings[key] = value;
    } else {
        extension_settings[extensionName][key] = value;
    }
    
    // SillyTavern的全局设置保存有延迟，这是正常的
    saveSettingsDebounced();
    console.log(`[${extensionName}] 全局设置已更新: ${key} ->`, value);
}


/**
 * [新增] 专门用于保存角色卡专属设置的函数。
 * @param {string} key - The setting key.
 * @param {*} value - The value to save.
 */
async function saveCharacterSetting(key, value) {
    const character = characters[this_chid];
    if (!character) {
        console.warn(`[${extensionName}] 无法保存角色设置，因为当前没有选中的角色。`);
        return;
    }

    // 确保路径存在
    if (!character.data.extensions) character.data.extensions = {};
    if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};

    character.data.extensions[extensionName][key] = value;
    
    // 使用SillyTavern的API来异步、原子化地保存角色数据
    try {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar: character.avatar,
                data: { 
                    extensions: { 
                        [extensionName]: {
                            [key]: value 
                        }
                    } 
                }
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
}
