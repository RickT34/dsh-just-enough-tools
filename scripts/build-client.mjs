import { build } from 'esbuild';
await build({
  entryPoints: ['client/index.ts'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-just-enough-tools",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
