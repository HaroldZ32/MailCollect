import { OnboardingWizard } from "../components/OnboardingWizard";

/**
 * 初始化面板的落点：向导自己渲染全屏浮层（fixed + backdrop），
 * 这里只保留稳定根节点，保证面板槽可独立挂载、不依赖 App 传入任何 props。
 */
export function OnboardingPage() {
  return (
    <div data-panel="onboarding" data-testid="onboarding-panel">
      <OnboardingWizard />
    </div>
  );
}
