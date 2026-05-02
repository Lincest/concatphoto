# Concat Photo

A pure frontend photo collage tool for creating vertical image layouts.

## Usage

Open `index.html` directly in a browser.

Supported actions:

- Upload multiple photos.
- Drop photos onto the canvas.
- Paste photos from the clipboard.
- Show import progress while photos are processed.
- Generate one collage region per uploaded photo.
- Use compressed working images for smooth preview, then rerender exports from original images.
- Drag canvas divider guides to resize photo regions.
- Drag a photo inside its region to adjust crop position.
- Drag a photo onto another canvas region to reorder the layout.
- Drag thumbnails to reorder photos.
- Choose common presets like `15:9`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `1:1`, `21:9`, or a custom ratio.
- Toggle and customize a small white bottom watermark.
- Remember ratio and watermark preferences in the browser for the next visit.
- Copy the rendered PNG to the clipboard when supported by the browser.
- Export PNG. The default `15:9` output is `1200 x 2000`.

## Files

- `index.html`: Page structure.
- `styles.css`: Interface styles.
- `app.js`: Photo loading, dynamic layout, canvas interaction, rendering, watermarking, and export logic.

## Vercel Git Integration

Connect the GitHub repository from the Vercel dashboard with `New Project`.
Vercel will automatically deploy pushes to the production branch and create preview deployments for other branches and pull requests.
