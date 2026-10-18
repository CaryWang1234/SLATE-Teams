"""技能：生成符合 SLATE 纯黑白风格的 HTML 骨架。"""

from __future__ import annotations

from typing import Any

TEMPLATE = """\
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: "Microsoft YaHei", "微软雅黑", sans-serif;
      background: #FFFFFF;
      color: #000000;
      line-height: 1.6;
      padding: 2rem;
    }}
    h1 {{ font-size: 1.5rem; border-bottom: 1px solid #DDDDDD; padding-bottom: 0.5rem; margin-bottom: 1rem; }}
    h2 {{ font-size: 1.2rem; margin: 1rem 0 0.5rem; }}
    p {{ margin-bottom: 0.8rem; }}
    .container {{ max-width: 800px; margin: 0 auto; }}
    .card {{
      border: 1px solid #DDDDDD;
      padding: 1rem;
      margin-bottom: 1rem;
      border-radius: 2px;
    }}
    code {{
      font-family: Consolas, "JetBrains Mono", monospace;
      background: #F8F8F8;
      padding: 0.1rem 0.3rem;
      font-size: 0.9em;
    }}
    pre {{
      background: #F8F8F8;
      padding: 1rem;
      overflow-x: auto;
      border: 1px solid #DDDDDD;
      margin-bottom: 1rem;
    }}
    pre code {{ background: none; padding: 0; }}
  </style>
</head>
<body>
  <div class="container">
    <h1>{title}</h1>
    {body}
  </div>
</body>
</html>"""


def execute(
    title: str = "SLATE 页面",
    body: str = "<p>内容区域</p>",
    html: str = "",
    **_: Any,
) -> dict[str, Any]:
    """生成纯黑白风格的 HTML 骨架。"""
    if html:
        body = html
    html = TEMPLATE.format(title=title, body=body)
    return {
        "title": title,
        "html": html,
        "style_guide": {
            "colors": ["#FFFFFF", "#000000", "#DDDDDD", "#F8F8F8"],
            "font_family": '"Microsoft YaHei", sans-serif',
            "code_font": 'Consolas, "JetBrains Mono", monospace',
            "max_border_radius": "4px",
        },
    }
