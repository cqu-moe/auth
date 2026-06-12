#!/usr/bin/env python3
"""classify_send_code 单测 —— 发码响应分类(sent / already_valid / failed)。

运行:
    python3 -m pytest container/test_classify_send_code.py   # 有 pytest
    python3 container/test_classify_send_code.py             # 无 pytest, 走内置 assert
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cqu_login import classify_send_code  # noqa: E402


# 2026-06 实测: 验证码有效期内重登录, 发码端点返回的真实 body。
ALREADY_VALID_BODY = {
    "code": 412,
    "message": "您的验证码还在有效期内，请勿重复发送",
    "data": {"result": False, "sendInterval": 0, "expireTime": 0},
}

# 成功发码的典型 body。
SUCCESS_BODY = {
    "code": 200,
    "message": "操作成功",
    "data": {"result": True, "sendInterval": 60, "expireTime": 600},
}

# 不相干的错误 body(如账号锁定/参数错误)。
UNRELATED_ERROR_BODY = {
    "code": 500,
    "message": "系统繁忙，请稍后再试",
    "data": {"result": False},
}


def test_already_valid_real_body():
    # 真实「请勿重复发送」body → already_valid(旧码仍有效, 继续等码)。
    assert classify_send_code(412, ALREADY_VALID_BODY) == "already_valid"


def test_already_valid_via_message_only_200_http():
    # 即便 HTTP 200, 只要带「请勿重复发送」也算 already_valid。
    assert classify_send_code(200, {"code": 412, "message": "请勿重复发送", "data": {"result": False}}) == "already_valid"


def test_sent_success():
    # 成功 body → sent。
    assert classify_send_code(200, SUCCESS_BODY) == "sent"


def test_sent_when_result_true_without_explicit_code_200():
    assert classify_send_code(200, {"message": "ok", "data": {"result": True}}) == "sent"


def test_failed_unrelated_error():
    # 不相干错误 → failed。
    assert classify_send_code(500, UNRELATED_ERROR_BODY) == "failed"


def test_failed_none_body():
    # 解析失败 body=None 且非 200 → failed。
    assert classify_send_code(412, None) == "failed"


def test_already_valid_expire_semantics():
    # code==412 + result False + 「有效期内」语义 → already_valid。
    body = {"code": 412, "message": "验证码仍在有效期内", "data": {"result": False}}
    assert classify_send_code(412, body) == "already_valid"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    if failures:
        print(f"\n{failures} test(s) failed")
        sys.exit(1)
    print("\nall tests passed")
