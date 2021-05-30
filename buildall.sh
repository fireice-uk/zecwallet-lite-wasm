protoc -I=proto proto/service.proto --js_out=import_style=commonjs:app/grpc --grpc-web_out=import_style=commonjs,mode=grpcwebtext:app/grpc
protoc -I=proto proto/compact_formats.proto --js_out=import_style=commonjs:app/grpc
cd app/wasm
wasm-pack build
cd ../..
npm install
npm run build
