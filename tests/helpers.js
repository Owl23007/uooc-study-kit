// 最小题目夹具通过真实提取和回填函数验证浏览器操作边界
export function quizFixture(count = 1, type = 'radio') {
    const questions = Array.from({ length: count }, (_, index) => {
        const inputs = ['A', 'B', 'C'].map(() => ({
            type, checked: false, disabled: false, isConnected: true,
            closest: () => null,
            click() {
                if (type === 'radio') inputs.forEach(input => { input.checked = false; });
                this.checked = type === 'radio' || !this.checked;
            },
        }));
        const options = inputs.map((input, optionIndex) => ({ querySelector(selector) {
            if (selector.startsWith('input')) return input;
            return { textContent: selector === '.ti-a-i' ? String.fromCharCode(65 + optionIndex) : `选项 ${optionIndex}` };
        } }));
        return {
            inputs,
            contains: () => false,
            querySelectorAll: selector => selector === '.ti-a' ? options : [],
            querySelector: () => ({ textContent: `题目内容 ${index + 1}` }),
        };
    });
    const document = {
        querySelector: () => null,
        querySelectorAll: selector => selector === '.queContainer' ? questions : [],
    };
    return { document, questions };
}
