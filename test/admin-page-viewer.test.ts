import { describe, it, expect } from 'vitest';
import { ADMIN_HTML } from '../src/admin-page.js';

describe('admin page viewer（静态结构）', () => {
  it('包含搜索框、聊天视图、结果视图容器', () => {
    expect(ADMIN_HTML).toContain('id="q"');
    expect(ADMIN_HTML).toContain('id="chat"');
    expect(ADMIN_HTML).toContain('id="results"');
  });

  it('包含聊天/搜索核心函数与原始报文入口', () => {
    expect(ADMIN_HTML).toContain('function openChat(');
    expect(ADMIN_HTML).toContain('function showView(');
    expect(ADMIN_HTML).toContain('function doSearch(');
    expect(ADMIN_HTML).toContain('原始报文');
  });

  it('对话数据渲染不拼 innerHTML（snippet/turn 均走 textContent）', () => {
    expect(ADMIN_HTML).not.toMatch(/innerHTML\s*=\s*[^'"<]/); // 只允许字面量赋值
    expect(ADMIN_HTML).toContain('textContent');
  });

  it('会话行有 💬 对话入口', () => {
    expect(ADMIN_HTML).toContain('💬');
    expect(ADMIN_HTML).toContain('openChat(');
  });
});
