// 预览用的模块加载器垫片：在 client.js 求值前把 window.__ModuleLoader__ 挂好。
window.__ModuleLoader__ = {
  load: (definition) => {
    window.__dshDefinition = definition
  },
}
