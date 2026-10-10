<template>
    <main class="persistence-page">
        <header class="benchmark-header">
            <h1>流式会话持久化性能测试</h1>

            <p>
                当前模式：
                <strong>{{ modeLabel }}</strong>
            </p>

            <p>
                历史会话：
                <strong>{{ sessionCount }} 个</strong>
            </p>

            <p>
                历史消息：
                <strong>
                    {{ totalMessageCount }} 条
                </strong>
            </p>

            <p>
                模拟流式分片：
                <strong>
                    {{ streamChunkCount }} 个
                </strong>
            </p>

            <p>
                初始会话快照：
                <strong>
                    {{ snapshotSizeKB.toFixed(2) }} KB
                </strong>
            </p>
        </header>

        <!-- 下一步显示正式测试结果 -->
        <section class="benchmark-result">
    <p>
        测试状态：
        <strong>{{ benchmarkStatus }}</strong>
    </p>

    <template v-if="benchmarkStatus === '测试完成'">
        <p>
            持久化执行次数：
            <strong>{{ persistCount }} 次</strong>
        </p>

        <p>
            localStorage写入次数：
            <strong>{{ storageWriteCount }} 次</strong>
        </p>

        <p>
            序列化与存储累计耗时：
            <strong>
                {{ persistenceDuration.toFixed(2) }} ms
            </strong>
        </p>

        <p>
            整个模拟过程耗时：
            <strong>
                {{ totalDuration.toFixed(2) }} ms
            </strong>
        </p>

        <p>
            最终会话快照：
            <strong>
                {{ finalSnapshotSizeKB.toFixed(2) }} KB
            </strong>
        </p>
    </template>
</section>
    </main>
</template>

<script setup lang="ts">
import {
    nextTick,
    onMounted,
    ref
} from 'vue';
// 导入项目已有的会话和消息类型
import type {
    ChatMessage,
    ChatSession
} from '@/types/chat';

// 固定测试规模，保证两种方案使用相同数据
const sessionCount = 10;
const messagesPerSession = 50;
const streamChunkCount = 300;
// 假设每隔10ms收到一个流式分片
const simulatedChunkIntervalMs = 10;

// 合并持久化的时间窗口：最多每200ms保存一次
const persistIntervalMs = 200;

// 读取URL参数
const params = new URLSearchParams(
    window.location.search
);

// baseline表示当前逐Token保存方案
// optimized表示后面要实现的合并保存方案
const mode =
    params.get('mode') === 'optimized'
        ? 'optimized'
        : 'baseline';

const modeLabel =
    mode === 'optimized'
        ? '合并持久化'
        : '逐Token持久化';

/**
 * 为一个会话生成固定数量的历史消息。
 *
 * sessionIndex：当前是第几个会话
 * count：当前会话需要多少条消息
 */
function createHistoryMessages(
    sessionIndex: number,
    count: number
): ChatMessage[] {
    return Array.from(
        { length: count },

        (_, messageIndex): ChatMessage => {
            // 用户和助手消息交替出现
            const role: ChatMessage['role'] =
                messageIndex % 2 === 0
                    ? 'user'
                    : 'assistant';

            return {
                id:
                    `session-${sessionIndex}-message-${messageIndex}`,

                role,

                // 使用固定长度的文本，
                // 确保每轮测试需要序列化的数据量一致
                content:
                    role === 'user'
                        ? [
                            `这是会话 ${sessionIndex + 1}`,
                            `中的第 ${messageIndex + 1} 条用户消息。`,
                            '请结合上下文分析当前项目的实现方案。'
                        ].join('')
                        : [
                            `这是会话 ${sessionIndex + 1}`,
                            `中的第 ${messageIndex + 1} 条助手回答。`,
                            '项目使用Vue管理页面状态，',
                            '通过SSE接收大模型流式响应，',
                            '并使用Pinia维护多会话、',
                            '工具调用和引用来源。',
                            '这段固定内容用于模拟已经保存的历史回答。'
                        ].join(''),

                // 使用固定时间，保证每次数据相同
                createdAt:
                    1700000000000 +
                    sessionIndex * 100000 +
                    messageIndex * 1000,

                status: 'done',
                tools: [],
                citations: []
            };
        }
    );
}

/**
 * 生成全部测试会话。
 */
function createBenchmarkSessions():
    ChatSession[] {
    return Array.from(
        { length: sessionCount },

        (_, sessionIndex): ChatSession => {
            const createdAt =
                1700000000000 +
                sessionIndex * 100000;

            return {
                id:
                    `benchmark-session-${sessionIndex}`,

                title:
                    `性能测试会话 ${sessionIndex + 1}`,

                createdAt,

                updatedAt:
                    createdAt +
                    messagesPerSession * 1000,

                messages: createHistoryMessages(
                    sessionIndex,
                    messagesPerSession
                )
            };
        }
    );
}

// 提前生成固定会话。
// 后面的baseline和optimized都会复制同一份数据。
const preparedSessions =
    createBenchmarkSessions();

// 计算真实的历史消息总数
const totalMessageCount =
    preparedSessions.reduce(
        (total, session) =>
            total + session.messages.length,
        0
    );

// 计算当前会话快照转换为JSON后的大小。
// 这个值只用于展示，不计入正式测试时间。
const snapshotJson =
    JSON.stringify(preparedSessions);

const snapshotSizeKB =
    new Blob([snapshotJson]).size / 1024;

// 使用专门的测试Key，避免覆盖项目中的真实会话数据
const TEST_SESSION_STORAGE_KEY =
    'persistence-benchmark-sessions';

const TEST_ACTIVE_SESSION_KEY =
    'persistence-benchmark-active-session';

// 下面这些ref负责保存最终测试结果
const benchmarkStatus = ref('准备中');
const persistCount = ref(0);
const storageWriteCount = ref(0);
const persistenceDuration = ref(0);
const totalDuration = ref(0);
const finalSnapshotSizeKB = ref(0);

/**
 * 模拟项目当前的persistSessions逻辑。
 *
 * 每调用一次都会：
 * 1. 把全部会话转换成JSON
 * 2. 写入会话数据
 * 3. 写入当前激活的会话ID
 */
function persistLikeCurrentProject(
    sessions: ChatSession[],
    activeSessionId: string
) {
    // 从这里开始计时，
    // 因此统计的是序列化和本地存储的总耗时
    const startTime = performance.now();

    const serialized =
        JSON.stringify(sessions);

    localStorage.setItem(
        TEST_SESSION_STORAGE_KEY,
        serialized
    );

    localStorage.setItem(
        TEST_ACTIVE_SESSION_KEY,
        activeSessionId
    );

    const duration =
        performance.now() - startTime;

    return {
        duration,
        serialized
    };
}

/**
 * 执行“逐Token持久化”基线测试。
 */
async function runBaselineBenchmark() {
    // 优化方案下一步再写
    if (mode !== 'baseline') {
        benchmarkStatus.value =
            '合并持久化方案将在下一步实现';
        return;
    }

    benchmarkStatus.value = '测试中';

    // 先清理测试数据，避免上一轮留下的数据影响本轮
    localStorage.removeItem(
        TEST_SESSION_STORAGE_KEY
    );

    localStorage.removeItem(
        TEST_ACTIVE_SESSION_KEY
    );

    /**
     * 根据准备好的JSON重新生成一份会话。
     *
     * 为什么需要复制？
     * 因为测试过程中会不断修改助手消息，
     * 不能直接修改preparedSessions，
     * 否则刷新前的多次测试数据可能不一致。
     *
     * 复制发生在正式计时之前，不计入测试耗时。
     */
    const sessions =
        JSON.parse(snapshotJson) as ChatSession[];

    // 选择最后一个会话，模拟当前正在聊天的会话
    const activeSession =
        sessions[sessions.length - 1];

    // 创建一条内容为空、仍在生成中的助手消息
    const assistantMessage: ChatMessage = {
        id: 'benchmark-streaming-message',
        role: 'assistant',
        content: '',
        createdAt: 1700009999999,
        status: 'streaming',
        tools: [],
        citations: []
    };

    activeSession.messages.push(
        assistantMessage
    );

    // 提前生成300个固定分片。
    // 分片生成过程不属于持久化性能，所以放在计时前。
    const streamChunks = Array.from(
        { length: streamChunkCount },
        () => '这是一个流式分片。'
    );

    // 让“测试中”先显示到页面上
    await nextTick();

    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });

    // 这些是本轮测试的临时统计值
    let currentPersistCount = 0;
    let currentPersistenceDuration = 0;
    let lastSerialized = snapshotJson;

    /**
     * 执行一次持久化，并累计结果。
     */
    function recordOnePersistence() {
        const result =
            persistLikeCurrentProject(
                sessions,
                activeSession.id
            );

        currentPersistCount += 1;

        currentPersistenceDuration +=
            result.duration;

        lastSerialized = result.serialized;
    }

    // 整个模拟过程开始计时
    const totalStartTime =
        performance.now();

    /**
     * 模拟300次SSE token事件。
     *
     * 当前项目的逻辑是：
     * 收到分片
     * → 拼接到助手消息
     * → touchActiveSession
     * → persistSessions
     */
    for (const chunk of streamChunks) {
        assistantMessage.content += chunk;

        // 模拟touchActiveSession更新时间
        activeSession.updatedAt += 10;

        // 当前方案每个分片都保存一次全部会话
        recordOnePersistence();
    }

    /**
     * 模拟done回调。
     *
     * 模型回答完成后，项目会把状态改成done，
     * 然后再次保存会话。
     */
    assistantMessage.status = 'done';
    activeSession.updatedAt += 1;
    recordOnePersistence();

    /**
     * 模拟finally中的最终状态清理。
     *
     * 当前项目finally中还会再调用一次
     * touchActiveSession，因此再保存一次。
     */
    activeSession.updatedAt += 1;
    recordOnePersistence();

    const totalEndTime =
        performance.now();

    // 一次持久化内部调用了两次localStorage.setItem
    persistCount.value =
        currentPersistCount;

    storageWriteCount.value =
        currentPersistCount * 2;

    persistenceDuration.value =
        currentPersistenceDuration;

    totalDuration.value =
        totalEndTime - totalStartTime;

    finalSnapshotSizeKB.value =
        new Blob([lastSerialized]).size / 1024;

    benchmarkStatus.value = '测试完成';

    // 测试结束后删除测试数据，不污染真实项目数据
    localStorage.removeItem(
        TEST_SESSION_STORAGE_KEY
    );

    localStorage.removeItem(
        TEST_ACTIVE_SESSION_KEY
    );
}

/**
 * 执行“合并持久化”优化测试。
 *
 * 设计思路：
 * 1. 每个Token仍然立即更新消息内容
 * 2. 但不立即写localStorage
 * 3. 每隔200ms最多保存一次
 * 4. 回答结束时强制保存最终状态
 */
async function runOptimizedBenchmark() {
    benchmarkStatus.value = '测试中';

    // 清理上一轮测试留下的数据
    localStorage.removeItem(
        TEST_SESSION_STORAGE_KEY
    );

    localStorage.removeItem(
        TEST_ACTIVE_SESSION_KEY
    );

    // 复制和基线方案完全相同的初始会话数据
    const sessions =
        JSON.parse(snapshotJson) as ChatSession[];

    // 使用最后一个会话模拟当前聊天
    const activeSession =
        sessions[sessions.length - 1];

    // 创建一条正在生成中的助手消息
    const assistantMessage: ChatMessage = {
        id: 'benchmark-streaming-message',
        role: 'assistant',
        content: '',
        createdAt: 1700009999999,
        status: 'streaming',
        tools: [],
        citations: []
    };

    activeSession.messages.push(
        assistantMessage
    );

    // 和基线方案使用完全相同的300个分片
    const streamChunks = Array.from(
        { length: streamChunkCount },
        () => '这是一个流式分片。'
    );

    // 等页面初始内容渲染完成后再测试
    await nextTick();

    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });

    // 本轮测试的统计结果
    let currentPersistCount = 0;
    let currentPersistenceDuration = 0;
    let lastSerialized = snapshotJson;

    /**
     * 模拟时间。
     *
     * 每收到一个分片增加10ms，
     * 不需要真的使用定时器等待。
     */
    let simulatedTime = 0;

    // 记录上一次持久化发生在什么时间
    let lastPersistTime = 0;

    /**
     * dirty表示内存中的会话是否有尚未保存的变化。
     *
     * true：消息变了，还没有保存
     * false：当前状态已经保存
     */
    let dirty = false;

    /**
     * 立即保存当前会话。
     *
     * 如果dirty为false，说明没有新变化，
     * 不需要重复写入localStorage。
     */
    function flushPersistence() {
        if (!dirty) {
            return;
        }

        const result =
            persistLikeCurrentProject(
                sessions,
                activeSession.id
            );

        currentPersistCount += 1;

        currentPersistenceDuration +=
            result.duration;

        lastSerialized = result.serialized;

        // 当前变化已经保存
        dirty = false;

        // 记录本次保存发生的模拟时间
        lastPersistTime = simulatedTime;
    }

    const totalStartTime =
        performance.now();

    /**
     * 模拟300次SSE Token事件。
     */
    for (const chunk of streamChunks) {
        // 消息内容仍然逐个分片更新，
        // 所以前端依然可以实现逐字显示
        assistantMessage.content += chunk;

        activeSession.updatedAt +=
            simulatedChunkIntervalMs;

        // 模拟本次分片经过了10ms
        simulatedTime +=
            simulatedChunkIntervalMs;

        // 消息发生了变化，但暂时没有保存
        dirty = true;

        /**
         * 距离上一次保存达到200ms时，
         * 才把这段时间内的多个分片一起保存。
         */
        if (
            simulatedTime - lastPersistTime >=
            persistIntervalMs
        ) {
            flushPersistence();
        }
    }

    /**
     * 模型回答完成。
     *
     * 即使距离上次保存还不足200ms，
     * 最终状态也必须立即保存。
     */
    assistantMessage.status = 'done';
    activeSession.updatedAt += 1;
    dirty = true;

    flushPersistence();

    /**
     * 模拟finally中的状态清理。
     *
     * 因为刚刚已经保存，dirty现在是false，
     * 所以这里不会产生一次无意义的重复写入。
     */
    flushPersistence();

    const totalEndTime =
        performance.now();

    persistCount.value =
        currentPersistCount;

    // 每次持久化会调用两次localStorage.setItem
    storageWriteCount.value =
        currentPersistCount * 2;

    persistenceDuration.value =
        currentPersistenceDuration;

    totalDuration.value =
        totalEndTime - totalStartTime;

    finalSnapshotSizeKB.value =
        new Blob([lastSerialized]).size / 1024;

    benchmarkStatus.value = '测试完成';

    // 删除测试数据，不影响项目真实会话
    localStorage.removeItem(
        TEST_SESSION_STORAGE_KEY
    );

    localStorage.removeItem(
        TEST_ACTIVE_SESSION_KEY
    );
}
// 页面加载完成后，自动执行测试
onMounted(() => {
    if (mode === 'optimized') {
        void runOptimizedBenchmark();
    } else {
        void runBaselineBenchmark();
    }
});
</script>

<style scoped>
.persistence-page {
    min-height: 100vh;
    padding: 24px;
    background: #f5f7fa;
    color: #1f2329;
}

.benchmark-header,
.benchmark-result {
    max-width: 1000px;
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

.benchmark-result {
    min-height: 120px;
}
</style>