/**
 * 发信通道。
 *
 * - `mime.ts`：新邮件/回复/转发的 MIME 构造（多条通道共用同一份字节）；
 * - `smtp.ts`：SMTP 提交（STARTTLS/SSL、AUTH PLAIN/LOGIN、超时、可注入假传输）；
 * - `dispatch.ts`：按账号选路 SMTP / Graph sendMail / EWS CreateItem，并决定 Sent 落点；
 * - `sent-mirror.ts`：本地「已发送」镜像（经注入的 store 端口写 raw_email + change_log）。
 *
 * 入口约定（captain 裁定，T47）：包根 `@mailcollect/core` 有意只导出 mail/types，
 * **不**再导出整个 mail 模块；下游请从 `@mailcollect/core/mail` 导入
 * （或窄路径 `@mailcollect/core/mail/send`）。不要假设 `import … from "@mailcollect/core"`
 * 能拿到本目录的 API。
 */
export * from "./mime.js";
export * from "./smtp.js";
export * from "./dispatch.js";
export * from "./sent-mirror.js";
