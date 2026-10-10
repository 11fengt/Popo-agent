// // 启动测试页面
// // Vue应用的创建函数
// import { createApp } from 'vue';

// // 下一步要创建的性能测试组件
// import BenchmarkApp from './BenchmarkApp.vue';

// // 复用正式项目的全局样式
// import '../styles.css';

// // 引入虚拟列表组件需要的样式
// import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';

// // 创建测试应用，并挂载到benchmark.html中的<div id="app">
// createApp(BenchmarkApp).mount('#app');


// 创建Vue应用
import { createApp } from 'vue';

// 长会话虚拟列表测试组件
import LongListBenchmarkApp
  from './BenchmarkApp.vue';

// 流式持久化测试组件
import PersistenceBenchmarkApp
  from './PersistenceBenchmarkApp.vue';

// 复用项目全局样式
import '../styles.css';

// 虚拟列表测试需要的组件样式
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';

// 读取浏览器地址中的查询参数
// 例如：?test=persistence&mode=baseline
const params = new URLSearchParams(
  window.location.search
);

// 读取要执行哪一种性能测试
const testType = params.get('test');

// 如果test=persistence，打开持久化测试；
// 否则继续打开之前的虚拟列表测试。
const RootComponent =
  testType === 'persistence'
    ? PersistenceBenchmarkApp
    : LongListBenchmarkApp;

// 创建对应的测试页面，并挂载到benchmark.html
createApp(RootComponent).mount('#app');