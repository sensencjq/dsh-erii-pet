const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const dir = __dirname;
const svgPath = process.argv[2] || path.join(dir, "erii.svg");
const svg = fs.readFileSync(svgPath, "utf8");

function render(name, height, bg) {
  const r = new Resvg(svg, {
    fitTo: { mode: "height", value: height },
    background: bg,
  });
  const data = r.render().asPng();
  fs.writeFileSync(path.join(dir, name), data);
  console.log(`${name}: ${data.length} bytes`);
}

render("preview.png", 1120, "rgba(0,0,0,0)");
render("preview-light.png", 1120, "#f6f1ec");
render("preview-320.png", 320, "#f6f1ec");
render("preview-160.png", 160, "#f6f1ec");
render("preview-dark.png", 1120, "#17121a");
