from datasets import load_dataset
ds = load_dataset("hotpotqa/hotpot_qa", "distractor")
# 查看数据集划分
print(ds)

# 取训练集、验证集
train_ds = ds["train"]
val_ds = ds["validation"]

# 查看单条样本
print(train_ds[0])
