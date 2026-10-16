// PDF.js 워커 진입점: 호환 보충(polyfill)을 먼저 실행한 뒤 실제 워커를 불러온다.
// (ES 모듈은 import 순서대로 평가되므로 아래 순서가 중요)
import "./compat-polyfills.mjs";
import "./pdf.worker.mjs";
