# ADR 0006：精确的数字表示

- 状态：已接受
- 日期：2026-08-14

## 决定

引擎将价格、数量和金钱表示为经过验证的 `i128` 新类型并经过检查
算术。市场定义`price_scale`和`quantity_scale`。 PostgreSQL 使用 `NUMERIC(38,0)` 和
wire JSON 将整数值编码为字符串，其中 JavaScript 精度是不安全的。
