/** 轻量不变量：金额不要在 money.ts 之外用浮点乘除；OA 适配器不能被改成启用。 */

function filePath(context) {
  return context.filename || context.getFilename?.() || "";
}

const mileagePlugin = {
  rules: {
    "no-float-money": {
      meta: {
        type: "problem",
        docs: { description: "金额计算必须走整数分" },
        schema: [],
        messages: {
          floatMoney: "金额请用 src/server/money.ts 的整数分，不要用浮点直接乘除。",
        },
      },
      create(context) {
        const filename = filePath(context).replaceAll("\\", "/");
        if (filename.endsWith("/src/server/money.ts") || filename.endsWith("/src/server/rates.ts")) return {};
        return {
          BinaryExpression(node) {
            if (node.operator !== "*" && node.operator !== "/") return;
            const text = context.sourceCode.getText(node);
            const looksLikeMoney = /\b(amount|yuan|fenPer|rateFen|amountFen)\b/i.test(text);
            const hasFloat = /\d+\.\d+/.test(text);
            if (looksLikeMoney && hasFloat) {
              context.report({ node, messageId: "floatMoney" });
            }
          },
        };
      },
    },
    "no-oa-enabled": {
      meta: {
        type: "problem",
        docs: { description: "OA 适配器保持禁用" },
        schema: [],
        messages: {
          enabled: "OA 适配器的 enabled、canSubmit、canPay、canCallback 必须保持 false。",
        },
      },
      create(context) {
        const filename = filePath(context).replaceAll("\\", "/");
        if (!filename.endsWith("/src/server/oa.ts")) return {};
        return {
          Property(node) {
            const name = node.key.type === "Identifier" ? node.key.name : null;
            if (!name || !["enabled", "canSubmit", "canPay", "canCallback"].includes(name)) return;
            if (node.value.type === "Literal" && node.value.value === true) {
              context.report({ node, messageId: "enabled" });
            }
          },
        };
      },
    },
  },
};

export default mileagePlugin;
