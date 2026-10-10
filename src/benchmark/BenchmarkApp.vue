<!--  普通列表和虚拟列表测试逻辑 -->
<template>
    <main class="benchmark-page">
        <header class="benchmark-header">
            <h1>长会话首次渲染测试</h1>

            <!-- 显示当前测试模式 -->
            <p>
                当前模式：
                <strong>{{ modeLabel }}</strong>
            </p>

            <!-- 显示准备生成多少条消息 -->
            <p>
                消息数量：
                <strong>{{ messageCount }}</strong>
            </p>
        </header>

        <!-- 测试结果区域 -->
        <section class="benchmark-result">
            <p>
                测试数据：
                {{ preparedMessages.length }} 条
            </p>

            <!-- renderDuration为null，表示测试还没结束 -->
            <p v-if="renderDuration === null">
                正在测试首次渲染时间……
            </p>

            <!-- 测试结束后显示具体耗时 -->
            <p v-else>
                首次渲染耗时：
                <strong>
                    {{ renderDuration.toFixed(2) }} ms
                </strong>
            </p>
        </section>
        <!-- 后面会把普通列表或虚拟列表放在这里 -->
        <!-- 测试结果区域 -->
        <!-- 普通列表对照组 -->
        <section v-if="showList && mode === 'plain'" class="benchmark-list">
            <!-- 普通列表会为所有消息创建MessageCard -->
            <MessageCard v-for="message in renderedMessages" :key="message.id" :message="message" />
        </section>

        <!-- 虚拟列表实验组 -->
        <DynamicScroller v-else-if="showList && mode === 'virtual'" class="benchmark-list" :items="renderedMessages"
            :min-item-size="120" key-field="id">
            <template #default="{ item, index, active }">
                <!-- 消息内容变化时重新计算高度 -->
                <DynamicScrollerItem :item="item" :active="active" 
                    :size-dependencies="[
                    item.content,
                    JSON.stringify(item.tools || []),
                    JSON.stringify(item.citations || [])
                    ]"

                    :data-index="index"
                    >
                    <!-- 与普通列表使用同一个消息组件 -->
                    <MessageCard :message="item" />
                </DynamicScrollerItem>
            </template>
        </DynamicScroller>
    </main>
</template>

<script setup lang="ts">
// 只导入ChatMessage的TypeScript类型，
// 不会产生额外的浏览器运行代码
// nextTick：等待Vue完成DOM更新
// onMounted：等待测试页面本身挂载完成
// ref：创建响应式测试状态
import {
    nextTick,
    onMounted,
    ref
} from 'vue';

// 复用正式项目的消息卡片，保证测试场景真实
import MessageCard from '@/components/MessageCard.vue';
// 项目正在使用的动态高度虚拟列表组件
import {
    DynamicScroller,
    DynamicScrollerItem
} from 'vue-virtual-scroller';

import type { ChatMessage } from '@/types/chat';

// 读取浏览器地址中的查询参数
// 例如：?mode=plain&count=1000
const params = new URLSearchParams(
    window.location.search
);

// 判断当前测试普通列表还是虚拟列表
const mode =
    params.get('mode') === 'virtual'
        ? 'virtual'
        : 'plain';

// 转换成页面显示的中文
const modeLabel =
    mode === 'virtual'
        ? '虚拟列表'
        : '普通列表';

// 尝试读取URL中的count参数
const requestedCount = Number(
    params.get('count') || 1000
);

// 防止用户传入abc、负数或小数
const messageCount =
    Number.isFinite(requestedCount) &&
        requestedCount > 0
        ? Math.floor(requestedCount)
        : 1000;

/**
 * 生成固定的测试消息。
 *
 * count表示需要生成多少条。
 * 每次打开页面都会生成相同结构的消息，
 * 确保普通列表和虚拟列表使用相同数据。
 */
function createBenchmarkMessages(
    count: number
): ChatMessage[] {
    return Array.from(
        { length: count },

        // 明确声明每一项都必须符合ChatMessage结构
        (_, index): ChatMessage => {
            // 偶数下标是用户消息，奇数下标是助手消息
            const role: ChatMessage['role'] =
                index % 2 === 0
                    ? 'user'
                    : 'assistant';

            return {
                // 每条消息必须有唯一ID，
                // 虚拟列表会使用它作为key
                id: `benchmark-message-${index}`,

                role,

                // 助手消息包含Markdown，
                // 让测试更接近真实项目
                content:
                    role === 'assistant'
                        ? [
                            `### 测试回答 ${index + 1}`,
                            '',
                            '这是一段用于测试长会话首次渲染性能的固定回答。',
                            '',
                            '- 使用 Vue 管理响应式状态',
                            '- 使用 nextTick 等待 DOM 更新',
                            '- 使用虚拟列表减少无效节点',
                            '',
                            '示例代码：`await nextTick()`'
                        ].join('\n')
                        : `这是第 ${index + 1} 条用户测试消息，请解释当前项目的长会话渲染方案。`,

                // 使用固定时间，避免每次测试数据不同
                createdAt:
                    1700000000000 + index * 1000,

                // 所有模拟消息都已经生成完成
                status: 'done',

                // 当前测试先不添加工具和引用，
                // 避免引入额外变量
                tools: [],
                citations: []
            };
        }
    );
}
// 提前生成固定测试数据。
// 这段代码在计时开始前执行，因此生成数据的时间不会算入渲染耗时。
const preparedMessages =
    createBenchmarkMessages(messageCount);

// 真正交给列表渲染的消息。
// 初始为空，保证测试开始前没有消息组件。
const renderedMessages =
    ref<ChatMessage[]>([]);

// 控制列表是否出现在页面中。
// 测试开始后才变成true，确保列表组件的创建时间也被统计。
const showList = ref(false);

// 保存本次首次渲染耗时。
// null表示测试尚未结束。
const renderDuration =
    ref<number | null>(null);

/**
 * 等待浏览器进入下一次绘制。
 */
function waitForAnimationFrame() {
    return new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
            resolve();
        });
    });
}

/**
 * 执行一次列表首次渲染测试。
 *
 * 当前URL中的mode决定使用普通列表还是虚拟列表，
 * 两种模式共用这套计时代码。
 */
async function runBenchmark() {
    // 先等待标题、测试说明等页面骨架渲染完成
    await nextTick();

    // 从这里开始计时
    const startTime = performance.now();

    // 把准备好的1000条消息交给列表
    renderedMessages.value =
        preparedMessages;

    // 此时才创建普通列表或虚拟列表组件
    showList.value = true;

    // 等待Vue创建组件并更新DOM
    await nextTick();

    // 等待浏览器完成布局和绘制
    await waitForAnimationFrame();
    await waitForAnimationFrame();

    // 计算渲染耗时
    renderDuration.value =
        performance.now() - startTime;

    // 输出到浏览器控制台
    console.log({
        mode,
        messageCount,
        duration:
            `${renderDuration.value.toFixed(2)} ms`
    });
}

// 页面骨架加载完成后自动测试。
// plain和virtual都会执行同一个函数。
onMounted(() => {
    runBenchmark();
});
</script>

<style scoped>
.benchmark-page {
    min-height: 100vh;
    padding: 24px;
    background: #f5f7fa;
    color: #1f2329;
}

.benchmark-header {
    max-width: 1200px;
    margin: 0 auto 20px;
    padding: 20px;
    border-radius: 12px;
    background: #ffffff;
}

.benchmark-header h1 {
    margin: 0 0 16px;
}

.benchmark-header p {
    margin: 8px 0;
}

.benchmark-placeholder {
    max-width: 1200px;
    height: 500px;
    margin: 0 auto;
    display: grid;
    place-items: center;
    border: 1px dashed #aab2c0;
    border-radius: 12px;
    background: #ffffff;
    color: #667085;
}

.benchmark-result {
    max-width: 1200px;
    margin: 0 auto 20px;
    padding: 16px 20px;
    border-radius: 12px;
    background: #ffffff;
}

.benchmark-result p {
    margin: 6px 0;
}

.benchmark-list {
    max-width: 1200px;

    /* 固定测试容器高度 */
    height: 600px;

    margin: 0 auto;
    overflow-y: auto;
    border-radius: 12px;
    background: #ffffff;
}
</style>