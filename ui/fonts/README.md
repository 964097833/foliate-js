# Offline Chinese serif font

`noto-serif-sc.woff2` is Noto Serif SC, distributed under the SIL Open Font License
1.1 in `OFL.txt`. Source: [Google Fonts / Noto Serif SC](https://github.com/google/fonts/tree/main/ofl/notoserifsc).

Fetched on 2026-10-18 from `NotoSerifSC[wght].ttf`, Git blob
`eab063faf229160a52d3760f5555150e4eb9e5bf`. Original TTF SHA-256:
`050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9`.

Converted without subsetting or changing glyphs/axes using fontTools 4.67.0:

```python
from fontTools.ttLib import TTFont
font = TTFont('NotoSerifSC.ttf')
font.flavor = 'woff2'
font.save('noto-serif-sc.woff2')
```

iPhone loads the packaged font before opening a book and registers the loaded
FontFace in each chapter. CSS aliases it as `Foliate Serif`; the font's internal
name is unchanged. Mac keeps its existing Songti SC first choice. No runtime
font download, new network origin, or iframe CSP exception is required.
