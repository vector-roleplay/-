import { loadWorldInfo, world_names } from "/scripts/world-info.js";
import { characters } from "/script.js";
import { getContext } from "/scripts/extensions.js";

/**
 * 检查 TavernHelper API 是否可用。
 * @returns {boolean}
 */
export function isTavernHelperAvailable() {
    return typeof window.TavernHelper !== 'undefined' && 
           window.TavernHelper !== null &&
           typeof window.TavernHelper.getLorebooks === 'function';
}

/**
 * 安全地获取所有世界书的名称列表。
 * 如果 TavernHelper 可用，则使用它；否则回退到旧版 API。
 * @returns {Promise<string[]>}
 */
export async function safeLorebooks() {
    try {
        if (isTavernHelperAvailable()) {
            return await window.TavernHelper.getLorebooks();
        }
        return [...world_names];
    } catch (error) {
        console.error('[剧情优化大师-兼容性] 获取世界书列表失败:', error);
        return [...world_names];
    }
}

/**
 * 安全地获取当前角色关联的世界书。
 * @param {object} options - 选项对象，例如 { type: 'all' }。
 * @returns {Promise<{primary: string|null, additional: string[]}>}
 */
export async function safeCharLorebooks(options = { type: 'all' }) {
    try {
        if (isTavernHelperAvailable()) {
            return await window.TavernHelper.getCharLorebooks(options);
        }
        const context = getContext();
        const character = characters[context.characterId];
        const primary = character?.data?.extensions?.world;
        return { primary: primary || null, additional: [] };
    } catch (error) {
        console.error('[剧情优化大师-兼容性] 获取角色世界书失败:', error);
        const context = getContext();
        const character = characters[context.characterId];
        const primary = character?.data?.extensions?.world;
        return { primary: primary || null, additional: [] };
    }
}

/**
 * 安全地获取指定世界书的所有条目。
 * @param {string} bookName - 世界书的名称。
 * @returns {Promise<object[]>}
 */
export async function safeLorebookEntries(bookName) {
    try {
        if (isTavernHelperAvailable()) {
            return await window.TavernHelper.getLorebookEntries(bookName);
        }
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) return [];
        // 将旧版格式转换为 TavernHelper期望的格式
        return Object.entries(bookData.entries).map(([uid, entry]) => ({
            uid: parseInt(uid),
            comment: entry.comment || '无标题条目',
            content: entry.content || '',
            key: entry.key || [],
            keys: entry.keys || [], // 确保keys属性存在
            enabled: !entry.disable,
            type: entry.constant ? 'constant' : 'triggered', // 转换类型
            prevent_recursion: entry.prevent_recursion || false,
            exclude_recursion: entry.exclude_recursion || false,
        }));
    } catch (error) {
        console.error(`[剧情优化大师-兼容性] 获取世界书 ${bookName} 条目失败:`, error);
        return [];
    }
}
