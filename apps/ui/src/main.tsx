import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import "./styles/tokens.css";
import "./styles/global.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html 缺少 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    {/* 根级兜底（C8）：渲染错误时展示错误卡，App 的根节点不卸载，避免白屏。 */}
    <ErrorBoundary scope="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
