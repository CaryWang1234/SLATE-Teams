"""技能：文档编写 —— 生成 Markdown 格式的技术文档或需求说明。"""

from __future__ import annotations

from typing import Any


def execute(
    title: str = "",
    doc_type: str = "technical",
    sections: str = "",
    content_hint: str = "",
    content: str = "",
    **_kw: Any,
) -> dict[str, Any]:
    """
    生成 Markdown 格式的技术文档。

    参数:
        title: 文档标题
        doc_type: 文档类型（technical / requirement / api / readme / changelog）
        sections: 需要的章节，逗号分隔（如"概述,安装,配置,API"）
        content_hint: 内容提示或关键信息
    """
    doc_title = title.strip() or "未命名文档"
    dtype = doc_type.strip().lower()
    hint = (content_hint or content).strip()

    # 文档模板
    templates: dict[str, dict[str, Any]] = {
        "technical": {
            "default_sections": ["概述", "架构设计", "技术栈", "目录结构", "核心模块", "部署说明"],
            "intro": "本文档描述项目的技术实现方案。",
        },
        "requirement": {
            "default_sections": ["背景与目标", "功能需求", "非功能需求", "用户故事", "验收标准", "排期建议"],
            "intro": "本文档描述项目的功能需求与验收标准。",
        },
        "api": {
            "default_sections": ["接口概览", "认证方式", "请求格式", "响应格式", "接口列表", "错误码"],
            "intro": "本文档描述 API 接口规范。",
        },
        "readme": {
            "default_sections": ["简介", "快速开始", "安装", "使用方法", "配置说明", "常见问题"],
            "intro": "项目说明文档。",
        },
        "changelog": {
            "default_sections": ["最新版本", "变更记录", "已知问题", "后续计划"],
            "intro": "项目变更记录。",
        },
    }

    tpl = templates.get(dtype, templates["technical"])

    # 解析用户指定章节
    if sections.strip():
        section_list = [s.strip() for s in sections.split(",") if s.strip()]
    else:
        section_list = tpl["default_sections"]

    def section_body(section: str) -> str:
        if hint:
            return f"围绕“{hint}”补充本节内容，重点说明 {section} 的事实、约束与待确认事项。"
        return f"本节用于说明 {section}。当前未提供更多上下文，请在补充材料后完善具体内容。"

    # 生成 Markdown
    lines: list[str] = []
    lines.append(f"# {doc_title}")
    lines.append("")
    lines.append(f"> {tpl['intro']}")
    lines.append("")

    if hint:
        lines.append(f"**关键信息**: {hint}")
        lines.append("")

    lines.append("---")
    lines.append("")

    for i, sec in enumerate(section_list, 1):
        lines.append(f"## {i}. {sec}")
        lines.append("")
        lines.append(section_body(sec))
        lines.append("")

    lines.append("---")
    lines.append("")
    from datetime import datetime
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines.append(f"*文档生成时间: {now}（SLATE 砚）*")

    markdown = "\n".join(lines)

    return {
        "markdown": markdown,
        "title": doc_title,
        "doc_type": dtype,
        "sections": section_list,
        "word_count": len(markdown),
        "note": "已生成可直接预览的文档初稿，各章节可根据实际材料继续细化。",
    }
