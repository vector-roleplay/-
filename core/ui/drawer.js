// 快速响应部队 - UI抽屉创建
// 由Cline移植并重构

import { extensionName } from '../utils/settings.js';
import { initializeBindings, saveAllSettings } from './bindings.js';

const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

/**
 * 创建并注入插件的设置面板到SillyTavern的扩展设置页面。
 */
export async function createDrawer() {
    // 防止重复创建
    if ($('#qrf_extension_frame').length > 0) return;

    const extensionHtml = `
        <div id="qrf_extension_frame">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fas fa-magic" style="color: #a977ff;"></i> 剧情优化大师</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <!-- 设置面板将在这里加载 -->
                </div>
            </div>
        </div>
    `;

    // 将面板添加到SillyTavern的扩展设置区域
    $('#extensions_settings2').append(extensionHtml);

    try {
        const contentWrapper = $('#qrf_extension_frame .inline-drawer-content');
        const settingsPanelHtml = await $.get(`/${extensionFolderPath}/settings.html?v=${Date.now()}`);
        contentWrapper.html(settingsPanelHtml);

        // 初始化UI数据绑定和事件
        initializeBindings();
        
        console.log(`[${extensionName}] 设置面板已成功创建。`);

    } catch (error) {
        console.error(`[${extensionName}] 加载设置面板HTML时发生错误:`, error);
        $('#qrf_extension_frame .inline-drawer-content').html('<p style="color:red; padding:10px;">错误：无法加载插件设置界面。</p>');
    }
}
