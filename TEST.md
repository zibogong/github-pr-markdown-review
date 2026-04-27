# Markdown Test File

This file is used to test the GitHub PR markdown review Chrome extension.

## Text Formatting

**Bold text**, *italic text*, ~~strikethrough~~, and `inline code`.

> This is a blockquote.
> It can span multiple lines.

## Lists

### Unordered
- Item one
- Item two
  - Nested item
  - Another nested item
- Item three

### Ordered
1. First step
2. Second step
3. Third step

## Code Blocks

```javascript
function greet(name) {
  return `Hello, ${name}!`;
}

console.log(greet("World"));
```

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"

print(greet("World"))
```

## Tables

| Feature         | Status  | Notes                        |
|-----------------|---------|------------------------------|
| Bold/Italic     | Done    | Basic formatting             |
| Code blocks     | Done    | Syntax highlighting          |
| Tables          | Done    | Alignment support            |
| Task lists      | Planned | Requires interactive support |
| Math (LaTeX)    | Planned | KaTeX integration            |

## Task List

- [x] Set up repository
- [x] Create test markdown file
- [ ] Build Chrome extension
- [ ] Add content script for PR pages
- [ ] Render markdown preview panel

## Links & Images

[GitHub PR Markdown Review](https://github.com/zibogong/github-pr-markdown-review)

## Horizontal Rule

---

## Nested Blockquote

> Level 1
>
> > Level 2
> >
> > > Level 3

## Math (if supported)

Inline: $E = mc^2$

Block:
$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$
