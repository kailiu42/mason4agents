use crate::types::{msg, Result};
use serde_json::Value;

pub fn render_template(input: &str, context: &Value) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let end = after_start
            .find("}}")
            .ok_or_else(|| msg(format!("unterminated expression in '{input}'")))?;
        let expr = &after_start[..end];
        out.push_str(&eval_expression(expr, context)?);
        rest = &after_start[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

pub fn eval_expression(expr: &str, context: &Value) -> Result<String> {
    let mut parts = expr.split('|').map(str::trim);
    let first = parts.next().ok_or_else(|| msg("empty expression"))?;
    if first.is_empty() {
        return Err(msg("empty expression"));
    }
    let value = lookup_path(context, first)?;
    let mut rendered = json_value_to_string(value)?;
    for filter in parts {
        rendered = apply_filter(&rendered, filter)?;
    }
    Ok(rendered)
}

fn lookup_path<'a>(context: &'a Value, path: &str) -> Result<&'a Value> {
    let mut cur = context;
    for segment in path.split('.').map(str::trim) {
        if segment.is_empty() {
            return Err(msg(format!("invalid expression path '{path}'")));
        }
        cur = cur
            .get(segment)
            .ok_or_else(|| msg(format!("unknown expression variable '{path}'")))?;
    }
    Ok(cur)
}

fn json_value_to_string(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Err(msg("expression resolved to null")),
        Value::Array(_) | Value::Object(_) => Err(msg("expression resolved to non-scalar value")),
    }
}

fn apply_filter(input: &str, filter: &str) -> Result<String> {
    let Some(args) = filter.strip_prefix("strip_prefix") else {
        return Err(msg(format!("unknown expression filter '{filter}'")));
    };
    let prefix = parse_single_string_arg(args.trim())?;
    Ok(input.strip_prefix(prefix).unwrap_or(input).to_owned())
}

fn parse_single_string_arg(input: &str) -> Result<&str> {
    if input.len() < 2 || !input.starts_with('"') || !input.ends_with('"') {
        return Err(msg(format!(
            "filter argument must be a quoted string: {input}"
        )));
    }
    Ok(&input[1..input.len() - 1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_version_and_asset_paths() {
        let ctx = json!({"version":"v1.2.3","source":{"asset":{"bin":"bin/tool"}}});
        assert_eq!(
            render_template("tool-{{version}}", &ctx).unwrap(),
            "tool-v1.2.3"
        );
        assert_eq!(
            render_template("{{ source.asset.bin }}", &ctx).unwrap(),
            "bin/tool"
        );
    }

    #[test]
    fn supports_strip_prefix_filter() {
        let ctx = json!({"version":"v1.2.3"});
        assert_eq!(
            render_template("{{ version | strip_prefix \"v\" }}", &ctx).unwrap(),
            "1.2.3"
        );
    }

    #[test]
    fn rejects_unknown_variable_and_filter() {
        let ctx = json!({"version":"1"});
        assert!(render_template("{{missing}}", &ctx).is_err());
        assert!(render_template("{{version | lower}}", &ctx).is_err());
    }
}
